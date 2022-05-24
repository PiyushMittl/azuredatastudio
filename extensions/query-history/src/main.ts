/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azdata from 'azdata';
import * as vscode from 'vscode';
import { QueryHistoryNode } from './queryHistoryNode';
import { QueryHistoryProvider } from './queryHistoryProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Currently all the functionality for this is contained within the core ADS
	// code as the extensibility API doesn't currently support all the required
	// functionality (such as contributing tab panels)
	void vscode.commands.executeCommand('queryHistory.enableQueryHistory');
	const provider = new QueryHistoryProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider('queryHistory', provider));
	context.subscriptions.push(vscode.commands.registerCommand('queryHistory.open', async (node: QueryHistoryNode) => {
		// TODO Use provider ID from event
		return azdata.queryeditor.openQueryDocument(
			{
				content: node.queryString
			}, 'MSSQL');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('queryHistory.run', async (node: QueryHistoryNode) => {
		// TODO Use provider ID from event
		const doc = await azdata.queryeditor.openQueryDocument(
			{
				content: node.queryString
			}, 'MSSQL');
		await azdata.queryeditor.connect(doc.uri, node.connectionId);
		azdata.queryeditor.runQuery(doc.uri);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('queryHistory.delete', (node: QueryHistoryNode) => {
		provider.deleteNode(node);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('queryHistory.clear', () => {
		provider.clearAll();
	}));
}

export async function deactivate(): Promise<void> {

}
