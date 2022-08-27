import { Event, EventEmitter, WorkspaceFolder } from 'vscode';
import {
  RetireEvent,
  TestAdapter,
  TestEvent,
  TestLoadFinishedEvent,
  TestLoadStartedEvent,
  TestRunFinishedEvent,
  TestRunStartedEvent,
  TestSuiteEvent
} from 'vscode-test-adapter-api';
import { EXTENSION_CONFIG_PREFIX, EXTENSION_OUTPUT_CHANNEL_NAME, KARMA_SERVER_OUTPUT_CHANNEL_NAME } from './constants';
import { TestLoadEvent, TestResultEvent, TestRunEvent } from './core/base/test-events';
import { GeneralConfigSetting, InternalConfigSetting, ProjectConfigSetting } from './core/config/config-setting';
import { ConfigStore } from './core/config/config-store';
import { ExtensionConfig } from './core/config/extension-config';
import { Debugger } from './core/debugger';
import { KarmaTestExplorer } from './core/karma-test-explorer';
import { MainFactory } from './core/main-factory';
import { Commands } from './core/vscode/commands/commands';
import { ProjectCommand } from './core/vscode/commands/project-command';
import { NotificationHandler } from './core/vscode/notifications/notification-handler';
import { StatusDisplay } from './core/vscode/notifications/status-display';
import { OutputChannelLog } from './core/vscode/output-channel-log';
import { KarmaLogLevel } from './frameworks/karma/karma-log-level';
import { Disposable } from './util/disposable/disposable';
import { Disposer } from './util/disposable/disposer';
import { FileHandler } from './util/filesystem/file-handler';
import { SimpleFileHandler } from './util/filesystem/simple-file-handler';
import { LogLevel } from './util/logging/log-level';
import { Logger } from './util/logging/logger';
import { SimpleLogger } from './util/logging/simple-logger';
import { PortAcquisitionClient } from './util/port/port-acquisition-client';
import { PortAcquisitionManager } from './util/port/port-acquisition-manager';
import { getJsonCircularReferenceReplacer } from './util/utils';

export class Adapter implements TestAdapter, Disposable {
  private readonly logLevel: LogLevel;
  private readonly outputChannelLog: OutputChannelLog;
  private readonly testServerLog: OutputChannelLog;
  private readonly logger: Logger;
  private readonly config: ExtensionConfig;
  private readonly portAcquisitionClient: PortAcquisitionClient;
  private readonly fileHandler: FileHandler;
  private readonly debugger: Debugger;
  private readonly projectCommands: Commands<ProjectCommand>;
  private readonly notificationHandler: NotificationHandler;
  private readonly testLoadEmitter: EventEmitter<TestLoadEvent>;
  private readonly testRunEmitter: EventEmitter<TestRunEvent | TestResultEvent>;
  private readonly retireEmitter: EventEmitter<RetireEvent>;
  private readonly disposables: Disposable[] = [];

  private karmaTestExplorer: KarmaTestExplorer;
  private testExplorerDisposables: Disposable[] = [];

  constructor(
    public readonly workspaceFolder: WorkspaceFolder,
    private readonly projectShortName: string,
    private readonly projectNamespace: string,
    configStore: ConfigStore<ProjectConfigSetting>,
    portAcquisitionManager: PortAcquisitionManager,
    projectStatusDisplay: StatusDisplay
  ) {
    this.logLevel = configStore.get<LogLevel>(GeneralConfigSetting.LogLevel);
    this.outputChannelLog = new OutputChannelLog(`${EXTENSION_OUTPUT_CHANNEL_NAME} (${this.projectNamespace})`);
    this.disposables.push(this.outputChannelLog);

    this.logger = this.createLogger(Adapter.name);

    this.fileHandler = new SimpleFileHandler(this.createLogger(SimpleFileHandler.name), {
      cwd: configStore.get(InternalConfigSetting.ProjectPath)
    });

    this.config = new ExtensionConfig(
      configStore,
      this.workspaceFolder.uri.path,
      this.fileHandler,
      this.createLogger(ExtensionConfig.name)
    );

    this.logger.debug(() => 'Creating server output channel');
    const serverOutputChannelName = `${KARMA_SERVER_OUTPUT_CHANNEL_NAME} (${this.projectNamespace})`;
    this.testServerLog = new OutputChannelLog(serverOutputChannelName, {
      enabled: this.config.karmaLogLevel !== KarmaLogLevel.DISABLE
    });
    this.disposables.push(this.testServerLog);

    this.logger.debug(() => 'Creating port acquisition client');
    this.portAcquisitionClient = new PortAcquisitionClient(
      portAcquisitionManager,
      this.createLogger(PortAcquisitionClient.name)
    );
    this.disposables.push(this.portAcquisitionClient);

    this.logger.debug(() => 'Creating debugger');
    this.debugger = new Debugger(this.createLogger(Debugger.name), {
      debuggerNamespace: projectShortName
    });
    this.disposables.push(this.debugger);

    this.logger.debug(() => 'Creating project commands handler');
    const commandsNamespace = `.${this.projectNamespace}`;
    this.projectCommands = new Commands<ProjectCommand>(
      this.createLogger(Commands.name),
      `${EXTENSION_CONFIG_PREFIX}${commandsNamespace}`
    );
    this.projectCommands.register(ProjectCommand.ShowLog, () => this.outputChannelLog.show());
    this.projectCommands.register(ProjectCommand.Reset, () => this.reset());
    this.disposables.push(this.projectCommands);

    this.logger.debug(() => 'Creating notifications handler');
    this.notificationHandler = new NotificationHandler(
      projectStatusDisplay,
      this.createLogger(NotificationHandler.name),
      { showLogCommand: this.projectCommands.getCommandName(ProjectCommand.ShowLog) }
    );
    this.disposables.push(this.notificationHandler);

    this.logger.debug(() => 'Creating test emitters');
    this.testLoadEmitter = new EventEmitter();
    this.testRunEmitter = new EventEmitter();
    this.retireEmitter = new EventEmitter();
    this.disposables.push(this.testLoadEmitter, this.testRunEmitter, this.retireEmitter);

    this.logger.debug(() => 'Creating initial test explorer');
    this.karmaTestExplorer = this.createTestExplorer();
  }

  private createTestExplorer(): KarmaTestExplorer {
    this.logger.debug(() => 'Assembling new test explorer');
    const testExplorerDisposables: Disposable[] = [];

    this.logger.debug(
      () =>
        `Re/creating test explorer with extension configuration: ` +
        `${JSON.stringify(this.config, getJsonCircularReferenceReplacer(), 2)}`
    );

    this.logger.debug(() => 'Creating main factory');
    const factory = new MainFactory(
      this.workspaceFolder,
      this.projectShortName,
      this.projectNamespace,
      this.config,
      this.debugger,
      this.portAcquisitionClient,
      this.fileHandler,
      this.projectCommands,
      this.notificationHandler,
      this.testLoadEmitter,
      this.testRunEmitter as EventEmitter<TestRunEvent>,
      this.testRunEmitter as EventEmitter<TestResultEvent>,
      this.retireEmitter,
      this.testServerLog,
      this.createLogger(MainFactory.name)
    );
    testExplorerDisposables.push(factory);

    this.logger.debug(() => 'Getting process handler from factory');
    const processHandler = factory.getProcessHandler();
    testExplorerDisposables.push(processHandler);

    this.logger.debug(() => 'Getting test locator from factory');
    const testLocator = factory.getTestLocator();
    testExplorerDisposables.push(testLocator);

    this.logger.debug(() => 'Getting test store from factory');
    const testStore = factory.getTestStore();
    testExplorerDisposables.push(testStore);

    this.logger.debug(() => 'Getting test manager from factory');
    const testManager = factory.createTestManager();
    testExplorerDisposables.push(testManager);

    this.logger.debug(() => 'Getting file watcher from factory');
    const fileWatcher = factory.createFileWatcher(); // FIXME: Fix non-intuitive side effect implementation for watching project files
    testExplorerDisposables.push(fileWatcher);

    this.logger.debug(() => 'Creating test explorer'); // FIXME: Add project path to log
    const testExplorer = new KarmaTestExplorer(
      this.workspaceFolder,
      this.config,
      testManager,
      testLocator,
      testStore,
      processHandler,
      this.debugger,
      this.testLoadEmitter,
      this.testRunEmitter,
      this.retireEmitter,
      this.notificationHandler,
      this.createLogger(KarmaTestExplorer.name)
    );

    this.testExplorerDisposables.push(...testExplorerDisposables);
    return testExplorer;
  }

  private createLogger(loggerName: string): SimpleLogger {
    return new SimpleLogger(this.outputChannelLog, loggerName, this.logLevel);
  }

  private async reset(): Promise<void> {
    this.logger.info(() => `Resetting adapter`);
    await this.disposeTestExplorer();
    this.karmaTestExplorer = this.createTestExplorer();
    this.load();
  }

  public async cancel(): Promise<void> {
    return this.reset();
  }

  public async run(testIds: string[]): Promise<void> {
    return this.karmaTestExplorer.runTests(testIds);
  }

  public async debug(testIds: string[]): Promise<void> {
    return this.karmaTestExplorer.debugTests(testIds);
  }

  public async load(): Promise<void> {
    return this.karmaTestExplorer.loadTests();
  }

  get tests(): Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testLoadEmitter.event;
  }

  get testStates(): Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> {
    return this.testRunEmitter.event;
  }

  get retire(): Event<RetireEvent> {
    return this.retireEmitter.event;
  }

  private async disposeTestExplorer(): Promise<void> {
    await this.karmaTestExplorer.dispose();
    await Disposer.dispose(this.testExplorerDisposables);
    this.testExplorerDisposables = [];
  }

  public async dispose(): Promise<void> {
    await this.disposeTestExplorer();
    await Disposer.dispose(this.disposables);
  }
}
