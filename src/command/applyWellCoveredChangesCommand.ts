import { inject, injectable } from "inversify";
import { Progress, ProgressLocation, Uri } from "vscode";
import { TYPES, VSC_TYPES, VscCommands, VscWindow, VscWorkspace } from "../di/types";
import { MergeService } from "../mergeService";
import { MatchManager } from "../migration/matchManger";
import { MigrationHolderRemote } from "../migration/migrationHolderRemote";
import { CoverageProvider } from "../providers/coverageProvider";
import { MatchCoverageFilter } from "../providers/matchCoverageFilter";
import { MatchFileSystemProvider } from "../providers/matchFileSystemProvider";
import { NonEmptyArray } from "../utilTypes";
import { Lock } from "../utils/lock";
import { parse, stringify, toFileUri } from "../utils/uri";
import { VersionControl } from "../vcs/versionControl";
import { ApplyCommand } from "./applyCommand";
import { Command } from "./command";

@injectable()
export class ApplyWellCoveredChangesCommand extends ApplyCommand implements Command {
    public readonly id = "vscode-migrate.apply-well-covered-matches";

    public constructor(
        @inject(TYPES.MatchFileSystemProvider) protected readonly changedContentProvider: MatchFileSystemProvider,
        @inject(VSC_TYPES.VscWindow) protected readonly window: VscWindow,
        @inject(VSC_TYPES.VscWorkspace) protected readonly workspace: VscWorkspace,
        @inject(TYPES.MatchManager) protected readonly matchManager: MatchManager,
        @inject(VSC_TYPES.VscCommands) protected readonly commands: VscCommands,
        @inject(TYPES.VersionControl) protected readonly versionControl: VersionControl,
        @inject(TYPES.MigrationHolderRemote) protected readonly migrationHolder: MigrationHolderRemote,
        @inject(TYPES.CoverageProvider) protected readonly coverageProvider: CoverageProvider,
        @inject(TYPES.MergeService) protected readonly mergeService: MergeService,
        @inject(TYPES.MatchCoverageFilter) protected readonly matchCoverageFilter: MatchCoverageFilter,
        @inject(TYPES.ApplyExecutionLock) private readonly applyLock: Lock,
    ) {
        super(window, matchManager, migrationHolder);
    }

    public async execute(): Promise<void> {
        const matches = await this.getWellCoveredMatches();
        await this.tryApplyLocked(matches);
    }

    private async tryApplyLocked(matches: Uri[]): Promise<void> {
        try {
            await this.applyLocked(matches);
        } catch (error) {
            this.handleApplyError(error);
        }
    }

    private applyLocked(matches: Uri[]): Promise<void> {
        return this.applyLock.lockWhile(() => this.apply(matches));
    }

    private async apply(matches: Uri[]): Promise<void> {
        await this.applyChangesWithProgress(matches);
        await this.checkMigrationDone();
    }

    private async getWellCoveredMatches(): Promise<Uri[]> {
        const filesWithCoveredMatches = await this.matchCoverageFilter.getQueuedFiles();
        const matchUrisGroupedByFile = await Promise.all(filesWithCoveredMatches.map((file) => this.matchCoverageFilter.getMatchUrisByFileUri(file)));
        return matchUrisGroupedByFile.flat();
    }

    private applyChangesWithProgress(matches: Uri[]): Thenable<void> {
        return this.window.withProgress({
            title: `Applying Well Covered Changes`,
            location: ProgressLocation.Notification
        }, progress => this.applyMatches(matches, progress));
    }

    private async applyMatches(matches: Uri[], progress: Progress<{ message?: string | undefined; increment?: number | undefined; }>): Promise<void> {
        await this.workspace.saveAll();

        const files = new Set(matches.map((match) => stringify(toFileUri(match))));
        for (const file of files) {
            await this.applyMatchesInFile(parse(file));
        }

        try {
            progress.report({ message: "Running verification tasks" });
            await this.migrationHolder.verify();
        } catch (error) {
            this.handleVerifyError(error);
        }

        await this.versionControl.stageAll();
        await this.versionControl.commit(`Batch application of ${matches.length} well covered matches for migration 'Brackets'`);
        this.matchManager.resolveEntries(matches);
    }

    private async applyMatchesInFile(fileUri: Uri): Promise<Uri[]> {
        const matches = await this.matchCoverageFilter.getMatchUrisByFileUri(fileUri) as NonEmptyArray<Uri>;
        const newContent = await this.changedContentProvider.getMergeResult(...matches);

        const newBuffer = Buffer.from(newContent);
        await this.workspace.fs.writeFile(fileUri, newBuffer);
        return matches;
    }
}
