/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUserDataSyncService, SyncStatus, IUserDataSyncStoreService, SyncSource, ISettingsSyncService, IUserDataSyncLogService, IUserDataSynchroniser, UserDataSyncStoreError, UserDataSyncErrorCode, UserDataSyncError, ResourceKey } from 'vs/platform/userDataSync/common/userDataSync';
import { Disposable } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Emitter, Event } from 'vs/base/common/event';
import { ExtensionsSynchroniser } from 'vs/platform/userDataSync/common/extensionsSync';
import { KeybindingsSynchroniser } from 'vs/platform/userDataSync/common/keybindingsSync';
import { GlobalStateSynchroniser } from 'vs/platform/userDataSync/common/globalStateSync';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { equals } from 'vs/base/common/arrays';
import { localize } from 'vs/nls';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';

type SyncErrorClassification = {
	source: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
};

const SESSION_ID_KEY = 'sync.sessionId';
const LAST_SYNC_TIME_KEY = 'sync.lastSyncTime';

export class UserDataSyncService extends Disposable implements IUserDataSyncService {

	_serviceBrand: any;

	private readonly synchronisers: IUserDataSynchroniser[];

	private _status: SyncStatus = SyncStatus.Uninitialized;
	get status(): SyncStatus { return this._status; }
	private _onDidChangeStatus: Emitter<SyncStatus> = this._register(new Emitter<SyncStatus>());
	readonly onDidChangeStatus: Event<SyncStatus> = this._onDidChangeStatus.event;

	readonly onDidChangeLocal: Event<SyncSource>;

	private _conflictsSources: SyncSource[] = [];
	get conflictsSources(): SyncSource[] { return this._conflictsSources; }
	private _onDidChangeConflicts: Emitter<SyncSource[]> = this._register(new Emitter<SyncSource[]>());
	readonly onDidChangeConflicts: Event<SyncSource[]> = this._onDidChangeConflicts.event;

	private _syncErrors: [SyncSource, UserDataSyncError][] = [];
	private _onSyncErrors: Emitter<[SyncSource, UserDataSyncError][]> = this._register(new Emitter<[SyncSource, UserDataSyncError][]>());
	readonly onSyncErrors: Event<[SyncSource, UserDataSyncError][]> = this._onSyncErrors.event;

	private _lastSyncTime: number | undefined = undefined;
	get lastSyncTime(): number | undefined { return this._lastSyncTime; }
	private _onDidChangeLastSyncTime: Emitter<number> = this._register(new Emitter<number>());
	readonly onDidChangeLastSyncTime: Event<number> = this._onDidChangeLastSyncTime.event;

	private readonly keybindingsSynchroniser: KeybindingsSynchroniser;
	private readonly extensionsSynchroniser: ExtensionsSynchroniser;
	private readonly globalStateSynchroniser: GlobalStateSynchroniser;

	constructor(
		@IUserDataSyncStoreService private readonly userDataSyncStoreService: IUserDataSyncStoreService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISettingsSyncService private readonly settingsSynchroniser: ISettingsSyncService,
		@IUserDataSyncLogService private readonly logService: IUserDataSyncLogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.keybindingsSynchroniser = this._register(this.instantiationService.createInstance(KeybindingsSynchroniser));
		this.globalStateSynchroniser = this._register(this.instantiationService.createInstance(GlobalStateSynchroniser));
		this.extensionsSynchroniser = this._register(this.instantiationService.createInstance(ExtensionsSynchroniser));
		this.synchronisers = [this.settingsSynchroniser, this.keybindingsSynchroniser, this.globalStateSynchroniser, this.extensionsSynchroniser];
		this.updateStatus();

		if (this.userDataSyncStoreService.userDataSyncStore) {
			this._register(Event.any(...this.synchronisers.map(s => Event.map(s.onDidChangeStatus, () => undefined)))(() => this.updateStatus()));
		}

		this._lastSyncTime = this.storageService.getNumber(LAST_SYNC_TIME_KEY, StorageScope.GLOBAL, undefined);
		this.onDidChangeLocal = Event.any(...this.synchronisers.map(s => Event.map(s.onDidChangeLocal, () => s.source)));
	}

	async pull(): Promise<void> {
		await this.checkEnablement();
		for (const synchroniser of this.synchronisers) {
			try {
				await synchroniser.pull();
			} catch (e) {
				this.handleSyncError(e, synchroniser.source);
			}
		}
		this.updateLastSyncTime();
	}

	async push(): Promise<void> {
		await this.checkEnablement();
		for (const synchroniser of this.synchronisers) {
			try {
				await synchroniser.push();
			} catch (e) {
				this.handleSyncError(e, synchroniser.source);
			}
		}
		this.updateLastSyncTime();
	}

	async sync(): Promise<void> {
		await this.checkEnablement();

		const startTime = new Date().getTime();
		this._syncErrors = [];
		try {
			this.logService.trace('Sync started.');
			if (this.status !== SyncStatus.HasConflicts) {
				this.setStatus(SyncStatus.Syncing);
			}

			let manifest = await this.userDataSyncStoreService.manifest();

			// Server has no data but this machine was synced before
			if (manifest === null && await this.hasPreviouslySynced()) {
				// Sync was turned off from other machine
				throw new UserDataSyncError(localize('turned off', "Cannot sync because syncing is turned off in the cloud"), UserDataSyncErrorCode.TurnedOff);
			}

			const sessionId = this.storageService.get(SESSION_ID_KEY, StorageScope.GLOBAL);
			// Server session is different from client session
			if (sessionId && manifest && sessionId !== manifest.session) {
				throw new UserDataSyncError(localize('session expired', "Cannot sync because current session is expired"), UserDataSyncErrorCode.SessionExpired);
			}

			for (const synchroniser of this.synchronisers) {
				try {
					await synchroniser.sync(manifest && manifest.latest ? manifest.latest[synchroniser.resourceKey] : undefined);
				} catch (e) {
					this.handleSyncError(e, synchroniser.source);
					this._syncErrors.push([synchroniser.source, UserDataSyncError.toUserDataSyncError(e)]);
				}
			}

			// After syncing, get the manifest if it was not available before
			if (manifest === null) {
				manifest = await this.userDataSyncStoreService.manifest();
			}

			// Update local session id
			if (manifest && manifest.session !== sessionId) {
				this.storageService.store(SESSION_ID_KEY, manifest.session, StorageScope.GLOBAL);
			}

			this.logService.info(`Sync done. Took ${new Date().getTime() - startTime}ms`);
			this.updateLastSyncTime();

		} finally {
			this.updateStatus();
			this._onSyncErrors.fire(this._syncErrors);
		}
	}

	async stop(): Promise<void> {
		await this.checkEnablement();
		if (this.status === SyncStatus.Idle) {
			return;
		}
		for (const synchroniser of this.synchronisers) {
			try {
				if (synchroniser.status !== SyncStatus.Idle) {
					await synchroniser.stop();
				}
			} catch (e) {
				this.logService.error(e);
			}
		}
	}

	async accept(source: SyncSource, content: string): Promise<void> {
		await this.checkEnablement();
		const synchroniser = this.getSynchroniser(source);
		await synchroniser.accept(content);
	}

	async getRemoteContent(source: SyncSource, preview: boolean): Promise<string | null> {
		await this.checkEnablement();
		for (const synchroniser of this.synchronisers) {
			if (synchroniser.source === source) {
				return synchroniser.getRemoteContent(preview);
			}
		}
		return null;
	}

	async resolveContent(resourceKey: ResourceKey, ref: string): Promise<string | null> {
		const synchronizer = this.synchronisers.filter(s => s.resourceKey === resourceKey)[0];
		if (synchronizer) {
			return synchronizer.resolveContent(ref);
		}
		return null;
	}

	async isFirstTimeSyncWithMerge(): Promise<boolean> {
		await this.checkEnablement();
		if (!await this.userDataSyncStoreService.manifest()) {
			return false;
		}
		if (await this.hasPreviouslySynced()) {
			return false;
		}
		return await this.hasLocalData();
	}

	async reset(): Promise<void> {
		await this.checkEnablement();
		await this.resetRemote();
		await this.resetLocal();
	}

	async resetLocal(): Promise<void> {
		await this.checkEnablement();
		this.storageService.remove(SESSION_ID_KEY, StorageScope.GLOBAL);
		this.storageService.remove(LAST_SYNC_TIME_KEY, StorageScope.GLOBAL);
		for (const synchroniser of this.synchronisers) {
			try {
				synchroniser.resetLocal();
			} catch (e) {
				this.logService.error(`${synchroniser.source}: ${toErrorMessage(e)}`);
				this.logService.error(e);
			}
		}
	}

	private async hasPreviouslySynced(): Promise<boolean> {
		for (const synchroniser of this.synchronisers) {
			if (await synchroniser.hasPreviouslySynced()) {
				return true;
			}
		}
		return false;
	}

	private async hasLocalData(): Promise<boolean> {
		for (const synchroniser of this.synchronisers) {
			if (await synchroniser.hasLocalData()) {
				return true;
			}
		}
		return false;
	}

	private async resetRemote(): Promise<void> {
		await this.checkEnablement();
		try {
			await this.userDataSyncStoreService.clear();
		} catch (e) {
			this.logService.error(e);
		}
	}

	private setStatus(status: SyncStatus): void {
		const oldStatus = this._status;
		if (this._status !== status) {
			this._status = status;
			this._onDidChangeStatus.fire(status);
			if (oldStatus === SyncStatus.HasConflicts) {
				this.updateLastSyncTime();
			}
		}
	}

	private updateStatus(): void {
		const conflictsSources = this.computeConflictsSources();
		if (!equals(this._conflictsSources, conflictsSources)) {
			this._conflictsSources = this.computeConflictsSources();
			this._onDidChangeConflicts.fire(conflictsSources);
		}
		const status = this.computeStatus();
		this.setStatus(status);
	}

	private computeStatus(): SyncStatus {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			return SyncStatus.Uninitialized;
		}
		if (this.synchronisers.some(s => s.status === SyncStatus.HasConflicts)) {
			return SyncStatus.HasConflicts;
		}
		if (this.synchronisers.some(s => s.status === SyncStatus.Syncing)) {
			return SyncStatus.Syncing;
		}
		return SyncStatus.Idle;
	}

	private updateLastSyncTime(): void {
		if (this.status === SyncStatus.Idle) {
			this._lastSyncTime = new Date().getTime();
			this.storageService.store(LAST_SYNC_TIME_KEY, this._lastSyncTime, StorageScope.GLOBAL);
			this._onDidChangeLastSyncTime.fire(this._lastSyncTime);
		}
	}

	private handleSyncError(e: Error, source: SyncSource): void {
		if (e instanceof UserDataSyncStoreError) {
			switch (e.code) {
				case UserDataSyncErrorCode.TooLarge:
					this.telemetryService.publicLog2<{ source: string }, SyncErrorClassification>('sync/errorTooLarge', { source });
			}
			throw e;
		}
		this.logService.error(e);
		this.logService.error(`${source}: ${toErrorMessage(e)}`);
	}

	private computeConflictsSources(): SyncSource[] {
		return this.synchronisers.filter(s => s.status === SyncStatus.HasConflicts).map(s => s.source);
	}

	getSynchroniser(source: SyncSource): IUserDataSynchroniser {
		return this.synchronisers.filter(s => s.source === source)[0];
	}

	private async checkEnablement(): Promise<void> {
		if (!this.userDataSyncStoreService.userDataSyncStore) {
			throw new Error('Not enabled');
		}
	}

}
