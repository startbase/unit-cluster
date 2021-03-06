var Config = new (require('./config'));
var settings = Config.getParams();

var params = {
	port: settings['ports']['server'],
	commit_hash: 'none',
	last_commit_hash: 'none',
	version: settings['version']
};

var argv = require('minimist')(process.argv.slice(2));
if (argv['p'] && typeof argv['p'] == "number") {
    params.port = argv['p'];
}

var readline = require('readline');
var rl = readline.createInterface(process.stdin, process.stdout);

var dgram = require('dgram');

var taskBalancer = new (require('./libs/task-balancer'))(settings['task_balancer']);
var testParser = new (require('./libs/test-parser'))(settings['parser']);
var repository = new (require('./libs/repository'))(settings['repository']);
var mailer = new (require('./libs/mailer'))(settings['mail']);
var queueEvents = new (require('./libs/queue'));
var Stats = new (require('./libs/stats'));
var weightBase = new (require('./libs/weight-base'))(settings['statistic']);

var ClusterLogs = new (require('./models/cluster-logs'));
var BrokenTests = new (require('./models/broken-tests'));

var users = [];

var io = require('socket.io').listen(params.port, {});
console.log('[' + getDate() + '] Сервер запущен. Порт: ' + params.port);
setLastCommitHash();
show_help();

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

/**
 * Когда очередь готова для раздачи обнуляем статистику
 * и говорим участникам, что они могут разбирать тесты
 */
taskBalancer.queueTasks.on('fill.complete', function () {
	weightBase.resetPool();
	Stats.reset();

	// Сохраняем данные в статистику
	Stats.commit_hash = params.commit_hash;
	Stats.build_tasks_count = taskBalancer.tasksCount();

	if (params.last_commit_hash != 'none' && params.last_commit_hash != params.commit_hash) {
		repository.getMergeCommitHistory(params.last_commit_hash, params.commit_hash, function(commits_merge) {
			Stats.commits_merge = commits_merge;
		});
	}

    console.log('\n[' + getDate() + '] Всего задач: ' + Stats.build_tasks_count);
    console.log('[' + getDate() + '] Раздаём задачи...');

	io.sockets.emit('dashboard.updateProgressBar', 0);
    io.sockets.emit('readyForJob');
});

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

rl.setPrompt('>>> ');
rl.prompt();
rl.on('line', function (line) {
    switch (line.trim()) {
        case 'h':
            show_help();
            break;
        case 'o':
            show_online_clients();
            break;
        case 'c':
			console.log('Прошлый commit hash сервера: ' + params.last_commit_hash);
            console.log('Текущий commit hash сервера: ' + params.commit_hash);
            break;
        case 't':
            console.log('Всего невыполненных задач: ' + taskBalancer.tasksCount());
            taskBalancer.queueTasks.tasks.forEach(function (task, i) {
                console.log((i + 1) + ': ' + task.taskName);
            });
			console.log('\n');
			console.log('Task Balancer Stats:');
			console.log(taskBalancer.prohStates.showState());
			console.log('\n');
            break;
        case 'e':
            console.log('Очищение очереди задач');
			Stats.build_tasks_count = 0;
            taskBalancer.clearTaskQueue();
			queueEvents.rmTask('in.process');
            io.sockets.emit('abortTask');
			io.sockets.emit('unbusyClient');
            break;
        case 'd':
            console.log(Stats.getDataForConsole());
            break;
        case 'u':
			if (!queueEvents.hasTask('need.update.repo')) {
				console.log('[' + getDate() + '] Задача по обновлению репозитория добавлена в очередь');
				queueEvents.addTask('need.update.repo');
			} else {
				console.log('[' + getDate() + '] Задача по обновлению репозитория уже есть в очереди');
			}
            return;
        default:
            console.log('bad command `' + line.trim() + '`');
            show_help();
            break;
    }
    rl.prompt();
});

rl.on('close', function () {
	console.log('Bye!');
	io.sockets.emit('abortTask');
	io.sockets.emit('unbusyClient');
	process.exit(0);
});

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

var udp_receiver = dgram.createSocket('udp4');

udp_receiver.on('error', function (err) {
	console.log('[' + getDate() + '] UDP: ' + err);
	udp_receiver.close();
});

udp_receiver.on('message', function (message) {
	console.log('[' + getDate() + '] Пришёл UDP пакет на обновление');

    console.log('MESSAGE to string:');
    console.log(message.toString('utf8'));

    if (message.toString('utf8') === 'beta' || message.toString('utf8') === 'integration') {
		rl.emit('line', 'u');
	}
});

udp_receiver.bind(settings['ports']['udp']);

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

/**
 * Человеко понятное время
 * @returns {string}
 */
function getDate() {
    var date = new Date();
    return date.toLocaleString();
}

function show_help() {
    console.log('help:');
    console.log('u - update repository');
    console.log('e - erase queue with tasks');
    console.log('d - show stats');
    console.log('t - show tasks');
    console.log('o - show online clients');
    console.log('c - show current commit hash');
    console.log('h - help');
}

function show_online_clients() {
    var user_index = 1;

    console.log('Список пользователей в системе:');
    for (var i = 0; i < users.length; i++) {
        console.log(user_index + '. ' + users[i][0] + ' (' + users[i][1] + ')');
        user_index++;
    }
    console.log('\n');
}

function isExistUser(username) {
	for (var i = 0; i < users.length; i++) {
		if (users[i][0] == username) {
			return true;
		}
	}

	return false;
}

function setLastCommitHash() {
	ClusterLogs.getLastPool(function (data) {
		if (data == null) {
			console.log('[' + getDate() + '] Данных по последнему выполненому пулу не обнаружено');
		} else {
			console.log('[' + getDate() + '] Последний commit hash билда: ' + data.commit_hash);
			params.last_commit_hash = data.commit_hash;
		}
	});
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

io.sockets.on('connection', function (socket) {

    /**
     * Запрашиваем регистрацию пользователя
     */
    if (socket.username === undefined) {
        socket.emit('needUserReg', params.version);
    }

    /**
     * Регистрация нового участника в системе
     * Новый участник готов к работе
     */
    socket.on('registerUser', function (data) {
		console.log('[' + getDate() + '] Новое подключение!');

		if (isExistUser(data.username)) {
			data.username = data.username + '_' +  + Date.now();
			socket.emit('changeClientName', data.username);
			socket.emit('userMessage', { message: 'Пользователь с таким именем уже есть в системе. Вас переименовали в ' + data.username });
		}

        socket.username = data.username;
        users.push([data.username, data.userinfo]);
        taskBalancer.clients_number++;

        console.log('[' + getDate() + '] ' + socket.username + ' подключился к системе');

		socket.emit('userMessage', { message: 'Регистрация прошла успешно!' });
        socket.emit('unbusyClient');
        socket.emit('readyForJob');
    });

    /**
     * Задача выполнена участником и он готов к новой работе
     */
    socket.on('readyTask', function (task) {
		socket.current_task = false;
		console.log('[' + getDate() + '] ' + socket.username + ' прислал данные по задаче ID: \n' + task.taskName);

		if (!task.response.status) {
			// Тест был завален
			console.log('[' + getDate() + '] ' + socket.username + ' завалил задачу ID: \n' + task.taskName);
			taskBalancer.registerFailed(socket.username, task);
			// Нужно отправить на повторную проверку?
			if (taskBalancer.canReturnTask(task)) {
				// Сохраним время выполнения phpunit
				Stats.phpunit_repeat_time += task.response.time;
				returnTaskToQueue(socket, task);
				return;
			}
		}

		console.log('[' + getDate() + '] ' + socket.username + ' выполнил задачу ID: \n' + task.taskName + ' за ' + (task.response.time).toFixed(4) + ' сек.');

		// Записываем статистику
		Stats.add(task.response);
		// Сохраняем данные по тяжести теста
		weightBase.addWeight({ taskName: task.taskName, weight: task.response.time });

        if (taskBalancer.tasksCount() > 0) {
            socket.emit('readyForJob');
        } else {
			socket.emit('userMessage', { message: 'Свободных задач в пуле нет' });
		}

		// если в статистике столько же тестов, сколько было изначально, то пул выполнен
		if (Stats.build_tasks_count == Stats.tests.length) {
			console.log('[' + getDate() + '] Все задачи из текущего пула выполнены');
			Stats.finish_time = Date.now();

			weightBase.saveWeights(function() {
				console.log('[' + getDate() + '] Данные по времени выполнения тестов последнего пула сохранены');
			});

			/** Освобождаем сервер */
			params.last_commit_hash = params.commit_hash;
			queueEvents.rmTask('in.process');
			console.log('[' + getDate() + '] Сервер свободен для создания нового пула задач');

			/** Сразу покажем статистику */
			rl.emit('line', 'd');

			/** Если в очереди есть задача на обновление репозитария - just do it! */
			if (queueEvents.hasTask('need.update.repo')) {
				queueEvents.rmTask('need.update.repo');
				queueEvents.addTask('update.repo');
			}

			io.sockets.emit('dashboard.changeStatus', Stats.isPoolFailed([]));
			io.sockets.emit('dashboard.updateProgressBar', 100);

			var build_data = Stats.processData();

            ClusterLogs.addPool(build_data, function() {
				console.log('[' + getDate() + '] Результаты выполнения последнего пула сохранены');
			});

			BrokenTests.getBrokenTests(function(failed_tests_old) {
				BrokenTests.update(build_data, failed_tests_old, function(notification) {
                    mailer.prepareMails(notification);
                });
			});
        } else {
            // Обновлям прогресс бар на дашборде
            io.sockets.emit('dashboard.updateProgressBar', Stats.getPercentOfComplete());
        }
    });

    /**
     * Получаем первую свободную задачу из списка
     * Отправляем участнику и говорим сколько ещё задач осталось
     */
    socket.on('getTask', function () {
        var task = taskBalancer.getTask(socket.username);

        if (task !== false) {
            console.log('[' + getDate() + '] ' + socket.username + ' взял задачу ID: \n' + task.taskName);
            socket.current_task = task;
            socket.emit('processTask', { task: task, commit_hash: params.commit_hash });
			socket.emit('userMessage', { message: 'Свободных задач в пуле: ' + taskBalancer.tasksCount() });
        } else {
            socket.emit('userMessage', { message: 'Свободных задач в пуле нет для клиента' });
			socket.emit('unbusyClient');
        }
    });

    /** Участник отключается от системы */
    socket.on('disconnect', function () {
		if (socket.username === undefined) {
			return;
		}

        /** Удаляем участника из обешго списка **/
		var index = -1;
		users.forEach(function(user, i) {
			if (user[0] == socket.username) {
				index = i;
			}
		});
        if (index != -1) {
            users.splice(index, 1);
        }
        taskBalancer.clients_number--;

        console.log('[' + getDate() + '] ' + socket.username + ' отключился от системы');

        /** Если клиент выполнял задачу - возвращаем её в очередь */
        if (socket.current_task) {
            returnTaskToQueue(socket, socket.current_task);
        }

        socket.username = undefined;
    });

    socket.on('rejectTask', function(data) {
        returnTaskToQueue(socket, data);
    });

    socket.on('serverMessage', function(data) {
        console.log('[' + getDate() + '] ' + data.message);
    });

    socket.on('dashboard.getLastState', function () {
        ClusterLogs.getLastPool(function (data) {
			if (data != null) {
				io.sockets.emit('dashboard.changeStatus', Stats.isPoolFailed(data));
				io.sockets.emit('dashboard.updateProgressBar', Stats.getPercentOfComplete());
			}
        });
    });
});

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

queueEvents.on('add', function (taskName) {
    switch (taskName) {
		case 'need.update.repo':
			if (!queueEvents.hasTask('in.process')) {
				queueEvents.rmTask('need.update.repo');
				queueEvents.addTask('update.repo');
			}
			break;
        case 'update.repo':
			queueEvents.addTask('in.process');
            taskBalancer.clearTaskQueue();
            var updateTimeout = setTimeout(function() {
                updateTimeout = null;
                queueEvents.tasks = [];
                queueEvents.rmTask('update.repo');
                console.log('[' + getDate() + '] Git update timeout. Waiting for a new update event...');
            }, settings['repository']['server_connection_timeout']);
			repository.update(function () {
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                    queueEvents.rmTask('update.repo');
                    queueEvents.addTask('set.commit.hash');
                }
			});
            break;
        case 'set.commit.hash':
            repository.getLastCommitHash(function(commit_hash) {
				params.commit_hash = commit_hash;
				queueEvents.rmTask('set.commit.hash');

				/**
				 * На данный момент UDP пакет присылается если кто-то освобождает ветку,
				 * при этом push может не сделан. Если новый комит соотв. комиту прошлого пула,
				 * то освобождаем сервер
				 */
				if (params.commit_hash == params.last_commit_hash) {
					console.log('[' + getDate() + '] Последний commit hash совпал с текущим. Запуск пула отменён. Сервер свободен');
					queueEvents.rmTask('in.process');
				} else {
					queueEvents.addTask('parser.start');
				}
            });
            break;
        case 'parser.start':
            testParser.processParse(function (err, result) {
                queueEvents.rmTask('parser.start');
                queueEvents.addTask('task.generate', {data: testParser.getCleanResults(result, settings['repository']['repository_path'])});
            });
            break;
        case 'task.generate':
            var taskEventObj = queueEvents.find('task.generate');
            queueEvents.rmTask('task.generate');
            taskBalancer.generateQueue(taskEventObj.params['data'], function(queueTasks) {
				weightBase.sortTasks(queueTasks, function() {
					taskBalancer.queueTasks.emit('fill.complete');
				});
			});
            break;
        case 'in.process':
			console.log('[' + getDate() + '] Сервер перешёл в режим создания и раздачи задач');
            break;
    }
});

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

function returnTaskToQueue(socket, current_task) {
    console.log('[' + getDate() + '] Задача ID: ' + current_task.taskName + ' возвращена в очередь');
    taskBalancer.queueTasks.addTask(current_task.taskName, current_task.params);
	socket.current_task = false;
	io.sockets.emit('readyForJob');
}
