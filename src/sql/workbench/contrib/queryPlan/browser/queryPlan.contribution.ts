/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { QueryPlanInput } from 'sql/workbench/contrib/queryPlan/common/queryPlanInput';
import { EditorDescriptor, IEditorRegistry, Extensions } from 'vs/workbench/browser/editor';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { Registry } from 'vs/platform/registry/common/platform';
import { QueryPlanEditor } from 'sql/workbench/contrib/queryPlan/browser/queryPlanEditor';
import { ILanguageAssociationRegistry, Extensions as LanguageAssociationExtensions } from 'sql/workbench/common/languageAssociation';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';

// Query Plan editor registration

const queryPlanEditorDescriptor = new EditorDescriptor(
	QueryPlanEditor,
	QueryPlanEditor.ID,
	'QueryPlan'
);

Registry.as<IEditorRegistry>(Extensions.Editors)
	.registerEditor(queryPlanEditorDescriptor, [new SyncDescriptor(QueryPlanInput)]);

Registry.as<ILanguageAssociationRegistry>(LanguageAssociationExtensions.LanguageAssociations)
	.registerLanguageAssociation('sqlplan', (accessor, editor) => {
		const instantiationService = accessor.get(IInstantiationService);
		return instantiationService.createInstance(QueryPlanInput, editor.getResource());
	}, (editor: QueryPlanInput) => undefined);
