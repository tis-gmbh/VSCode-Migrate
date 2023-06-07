import { copySync, emptyDirSync } from "fs-extra";
import { Container } from "inversify";
import { join } from "path";
import { DecorationInstanceRenderOptions, ExtensionContext } from "vscode";
import { modules, vscCommands } from "../../di/inversify.config";
import { TYPES, VSC_TYPES } from "../../di/types";
import { VSCodeMigrate } from "../../vscodeMigrate";
import { testModule, vscStubs } from "../inversify.test.config";
import { Logger } from "../logger";
import { TEST_TYPES } from "../types";
import { migrationsPath, originalPath, testWorkspacePath } from "../utils/fs";
import { startMigration } from "../utils/process";

type ValueOf<T> = T[keyof T];

interface Position {
    line: number;
    character: number;
}

interface Range {
    start: Position;
    end: Position;
}

export interface Decoration {
    range: Range
    options?: DecorationInstanceRenderOptions;
}

type ScenarioName = "applyWhileEdit"
    | "conflict"
    | "covered"
    | "coveredSingle"
    | "fullCoverage"
    | "hiddenCoverage"
    | "manualMerge"
    | "manualModification"
    | "partiallyCovered"
    | "singleFile"
    | "twoFile";

type MigrationName = "Brackets"
    | "Brackets - Custom Commit Message"
    | "Brackets - Whole File As Single Change"
    | "Lazy Suicidal"
    | "Suicidal";

export class Scenario {
    private readonly container = new Container();
    private vsCodeMigrate!: VSCodeMigrate;
    public name!: ScenarioName;

    private readonly extensionContext: ExtensionContext = {
        subscriptions: [],
    } as Partial<ExtensionContext> as ExtensionContext;

    public constructor() {
    }

    public async load(name: ScenarioName, migrationName?: MigrationName): Promise<void> {
        this.name = name;

        emptyDirSync(testWorkspacePath);
        copySync(originalPath(), testWorkspacePath, { recursive: true });
        copySync(migrationsPath, join(testWorkspacePath, ".vscode/migrations"));

        this.container.load(modules, vscStubs, vscCommands, testModule);
        this.vsCodeMigrate = this.container.get(TYPES.VscMigrate);
        this.vsCodeMigrate.activate(scenario.extensionContext);
        if (migrationName) {
            await startMigration(migrationName);
        }
    }

    public get<C>(
        module: ValueOf<typeof TYPES>
            | ValueOf<typeof VSC_TYPES>
            | ValueOf<typeof TEST_TYPES>
    ): C {
        return this.container.get<C>(module);
    }

    public getLogDumper(fileName: string): () => void {
        const logger = this.container.get<Logger>(TEST_TYPES.Logger);
        return () => {
            logger.dumpLogs(fileName);
        };
    }

    public log(message: string): void {
        const logger = this.container.get<Logger>(TEST_TYPES.Logger);
        logger.log(message);
    }

    public async teardown(): Promise<void> {
        const logger = this.container.get<Logger>(TEST_TYPES.Logger);
        logger.log("Tearing down scenario...");

        for (const sub of this.extensionContext.subscriptions) {
            sub.dispose();
        }

        await this.container.unbindAllAsync();

        logger.log("Scenario torn down.");
    }
}
