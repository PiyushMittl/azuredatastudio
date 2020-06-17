/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUserDataSyncService, IUserDataSyncLogService, IUserDataSyncEnablementService, IUserDataSyncStoreService } from 'vs/platform/userDataSync/common/userDataSync';
import { Event } from 'vs/base/common/event';
import { IElectronService } from 'vs/platform/electron/electron-sandbox/electron';
import { UserDataAutoSyncService as BaseUserDataAutoSyncService } from 'vs/platform/userDataSync/common/userDataAutoSyncService';
import { IUserDataSyncAccountService } from 'vs/platform/userDataSync/common/userDataSyncAccount';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';

export class UserDataAutoSyncService extends BaseUserDataAutoSyncService {

	constructor(
		@IUserDataSyncStoreService userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncEnablementService userDataSyncEnablementService: IUserDataSyncEnablementService,
		@IUserDataSyncService userDataSyncService: IUserDataSyncService,
		@IElectronService electronService: IElectronService,
		@IUserDataSyncLogService logService: IUserDataSyncLogService,
		@IUserDataSyncAccountService authTokenService: IUserDataSyncAccountService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService storageService: IStorageService,
		@IEnvironmentService environmentService: IEnvironmentService,
	) {
		super(userDataSyncStoreService, userDataSyncEnablementService, userDataSyncService, logService, authTokenService, telemetryService, storageService, environmentService);

		this._register(Event.debounce<string, string[]>(Event.any<string>(
			Event.map(electronService.onWindowFocus, () => 'windowFocus'),
			Event.map(electronService.onWindowOpen, () => 'windowOpen'),
		), (last, source) => last ? [...last, source] : [source], 1000)(sources => this.triggerSync(sources, true)));
	}

}
