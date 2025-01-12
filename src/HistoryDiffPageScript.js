// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { COMMENT_UPDATE_ID, GetCommentsWithHistory, GetTableInfosForEachComment } from './Comments.js';
import { InitSharedGlobals } from './Globals.js';
import { LoadConfiguration, InitializeConfigDialog, IsFieldHiddenByUserConfig } from './Configuration.js';
import { GetAllRevisionUpdates, GetTableInfosForEachRevisionUpdate } from './RevisionUpdates.js';
import { FormatDate, GetIdentityAvatarHtml, GetIdentityName, FilterInPlace } from './Utils.js';
import { WorkItemTrackingServiceIds } from 'azure-devops-extension-api/WorkItemTracking';


var gAdoSDK;
var gAdoAPI;
var gUnloadedCalled = false;


function GetHtmlDisplayField()
{
    const elem = document.getElementById('html-div-diff');
    if (!elem) {
        throw new Error('HistoryDiff: HTML element not found.');
    }
    return elem;
}


function SetHtmlToLoading()
{
    GetHtmlDisplayField().innerHTML = '<b>Loading history...</b>';
}


async function GetFullUpdateTables(comments, revisionUpdates, fieldsPropertiesMap, currentProjectName)
{
    const tablesForRevisionUpdates = await GetTableInfosForEachRevisionUpdate(revisionUpdates, fieldsPropertiesMap, currentProjectName);
    const tablesForCommentUpdates = GetTableInfosForEachComment(comments);
    const allUpdateTables = tablesForRevisionUpdates.concat(tablesForCommentUpdates);
    SortAndMergeAllTableInfosInplace(allUpdateTables);
    return allUpdateTables;
}


function SortAndMergeAllTableInfosInplace(allUpdateTables)
{
    // Sort from newest to oldest.
    allUpdateTables.sort((a, b) => b.changedDate - a.changedDate);

    // Especially because comments have been retrieved separately, there are updates that have been made at the same date 
    // by the same person. Merge these elements into one.
    let baseIdx = 0;
    while (baseIdx < allUpdateTables.length - 1) {
        // Find range of elements that we will merge: [baseIdx, idxNextDistinct)
        // Assumes that the array is already sorted appropriately (especially by date).
        let idxNextDistinct = baseIdx + 1;
        while (idxNextDistinct < allUpdateTables.length && CanUpdatesBeMerged(allUpdateTables[baseIdx], allUpdateTables[idxNextDistinct])) {
            ++idxNextDistinct;
        }

        if (idxNextDistinct === baseIdx + 1) {
            ++baseIdx;
            continue;
        }

        // Find a suitable element in the merge-range into which we will merge all other elements.
        let idxToMergeInto = baseIdx;
        while (idxToMergeInto < idxNextDistinct && allUpdateTables[idxToMergeInto].idNumber === COMMENT_UPDATE_ID) {
            ++idxToMergeInto;
        }
        
        if (idxToMergeInto >= idxNextDistinct) {
            ++baseIdx;
            continue;
        }

        const mergeInto = allUpdateTables[idxToMergeInto];

        // Copy all table rows in [baseIdx, idxNextDistinct) into 'mergeInto'.
        for (let idxForMerge = baseIdx; idxForMerge < idxNextDistinct; ++idxForMerge) {
            if (idxForMerge === idxToMergeInto) {
                continue;
            }
            const mergeSrc = allUpdateTables[idxForMerge];
            mergeInto.tableRows.push.apply(mergeInto.tableRows, mergeSrc.tableRows);
        }

        // Remove all elements in the merge-range except the element that we merged everything into.
        allUpdateTables.splice(idxToMergeInto + 1, idxNextDistinct - idxToMergeInto - 1);
        allUpdateTables.splice(baseIdx, idxToMergeInto - baseIdx);

        baseIdx = idxToMergeInto + 1;
    }
}


function CanUpdatesBeMerged(update1, update2)
{
    return update1.authorIdentity.descriptor === update2.authorIdentity.descriptor 
        && update1.changedDate && update2.changedDate && update1.changedDate.getTime() === update2.changedDate.getTime()
        && (update1.idNumber === COMMENT_UPDATE_ID || update2.idNumber === COMMENT_UPDATE_ID);
}


// Returns an object, where the property name is the work-item-field-type's referenceName such as 'System.Description', and the value is
// a WorkItemField: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemfield
async function GetMapOfFieldProperties(workItemFormService)
{
    // https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iworkitemformservice#azure-devops-extension-api-iworkitemformservice-getfields
    //
    // More or less corresponds to a REST request such as:
    // http://<Host>/<Collection>/<Project>/_apis/wit/fields (compare https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/fields/list)
    // (there is also e.g. http://<Host>/<Collection>/<Project>/_apis/wit/workitemtypes/issue/fields, 
    // https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types-field/list, but I don't think that this is the one underlying here.)
    //
    // Note that getFields() doesn't actually seem to issue a REST request because the information is already on the client.
    const propertiesOfAllFields = await workItemFormService.getFields();

    let map = {};
    for (const fieldProp of propertiesOfAllFields) {
        if (fieldProp?.referenceName) {
            map[fieldProp.referenceName] = fieldProp;
        }
    }

    return map;
}


async function GetProjectName()
{
    // projectService = IProjectPageService: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iprojectpageservice
    const projectService = await gAdoSDK.getService(gAdoAPI.CommonServiceIds['ProjectPageService']);
    // project = IProjectInfo: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iprojectinfo
    const project = await projectService.getProject();
    return project.name;
}


async function LoadAndSetDiffInHTMLDocument()
{
    SetHtmlToLoading();

    // workItemFormService = IWorkItemFormService 
    // https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iworkitemformservice
    // Not stored as global variable during initialization because the instance is tied to a certain work item,
    // and when the 'onLoaded' event is called, we might have switched to another work item. So need to get it again.
    const [workItemFormService, projectName] = await Promise.all([
        gAdoSDK.getService(WorkItemTrackingServiceIds.WorkItemFormService), 
        GetProjectName()
    ]);
    
    const [workItemId, fieldsPropertiesMap] = await Promise.all([
        workItemFormService.getId(),
        GetMapOfFieldProperties(workItemFormService)
    ]);

    const [revisionUpdates, comments] = await Promise.all([
        GetAllRevisionUpdates(workItemId, projectName),
        GetCommentsWithHistory(workItemId, projectName)
    ]);

    const allUpdateTables = await GetFullUpdateTables(comments, revisionUpdates, fieldsPropertiesMap, projectName);
    FilterTablesInPlace(allUpdateTables);
    const htmlString = CreateHTMLForAllUpdates(allUpdateTables);
    GetHtmlDisplayField().innerHTML = htmlString;
}


function FilterTablesInPlace(allUpdateTables)
{
    for (const updateInfo of allUpdateTables) {
        FilterInPlace(updateInfo.tableRows, (nameAndDiff) => !IsFieldHiddenByUserConfig(nameAndDiff.rowName));
    }
    FilterInPlace(allUpdateTables, (updateInfo) => updateInfo.tableRows.length != 0);
}


function CreateHTMLForAllUpdates(allUpdateTables)
{
    let s = '';
    for (const updateInfo of allUpdateTables) {
        const updateStr = CreateHTMLForUpdateOnSingleDate(updateInfo);
        if (updateStr) {
            s += `<hr><div>${updateStr}</div>`;
        }
    }
    return s;
}


function CreateHTMLForUpdateOnSingleDate(updateInfo)
{
    const tableRows = updateInfo.tableRows;
    if (!tableRows || tableRows.length == 0) {
        return null;
    }

    // Sort alphabetically.
    tableRows.sort((a, b) => a.rowName.localeCompare(b.rowName));

    const changedByName = GetIdentityName(updateInfo.authorIdentity);
    const avatarHtml = GetIdentityAvatarHtml(updateInfo.authorIdentity);
    const changedDateStr = updateInfo.changedDate ? FormatDate(updateInfo.changedDate) : 'an unknown date';
    const idStr = (updateInfo.idNumber && updateInfo.idNumber !== COMMENT_UPDATE_ID) ? ` (update ${updateInfo.idNumber})` : '';

    let s = `<div class="changeHeader">${avatarHtml} <b>${changedByName}</b> changed on <i>${changedDateStr}</i>${idStr}:</div>`;
    let tableRowsStr = '';
    for (const row of tableRows) {
        tableRowsStr += `<tr class="diffCls"><td class="diffCls">${row.rowName}</td><td class="diffCls">${row.content}</td></tr>`
    }
    s += `<table class="diffCls"><thead class="diffCls"><tr><th class="diffCls">Field</th><th class="diffCls">Content</th></tr></thead>
        <tbody>${tableRowsStr}</tbody></table>`;
    return s;
}


function IsDarkModeActive()
{
    // It would be awesome if we could have simply used the css '@media (prefers-color-scheme: dark)' feature. However,
    // this queries the browser setting regarding light or dark theme. But ADO ignores that setting, and instead
    // comes with a custom one. Sigh...
    //
    // We could ignore this and simply use the browser setting, assuming that a user enabling dark mode in the browser also
    // enabled dark mode in ADO. But this is probably a wrong assumption: ADO always displays a white background while 
    // editing a work item description, even if dark mode is enabled in the ADO settings, and thus 'flashes' the user with 
    // a big white box. ADO dark mode also has other problems (e.g. https://developercommunity.visualstudio.com/t/dark-mode-theme-should-display-font-colors-and-hig/1046206).
    // Thus I guess that a significant amount of dark-mode-users still choose to use the light mode in ADO.
    // 
    // There are also some css properties available from ADO: https://developer.microsoft.com/en-us/azure-devops/develop/styles
    // They come with different values for light and dark mode. Indeed, we do use some of them (see the '<style>' element in 
    // the html head). But for the '<ins>' and '<del>' elements I couldn't find anything that looks good in both light and dark mode.
    // 
    // So we need to detect light or dark mode dynamically instead of using the css feature. Unfortunately, 
    // there is no documented REST API to query the theme setting in ADO. We could use an undocumented API 
    // (https://stackoverflow.com/q/67775752/3740047, https://stackoverflow.com/q/61075867/3740047), but then we 
    // would need additional rights to read the user settings (scope 'vso.settings'). Using an undocumented API and requiring
    // additional rights seems like a bad choice. 
    //
    // There is also 'gAdoSDK.getPageContext().globalization.theme', but 'getPageContext()' always threw an error for me, 
    // complaining about init() not having finished (although it should have).
    //
    // So instead we simply read the text color and guess the theme from there.

    const textColorString = window.getComputedStyle(document.body, null).getPropertyValue('color');
    if (textColorString.indexOf('rgb') < 0) {
        console.log('HistoryDiff: Failed to detect theme.');
        return false;
    }

    // Based on https://stackoverflow.com/a/10971090/3740047
    const colorComponents = textColorString.replace(/[^\d,]/g, '').split(',').map(Number);
    if (colorComponents.length <= 2) {
        console.log('HistoryDiff: Failed to detect theme.');
        return false;
    }

    const textIsLight = colorComponents[0] > 127; // White text => dark mode enabled.
    return textIsLight;
}


function DetectAndApplyDarkMode()
{
    // We need to apply dark mode dynamically; see comment in IsDarkModeActive().
    const darkMode = IsDarkModeActive();
    if (darkMode) {
        document.head.insertAdjacentHTML(
            'beforeend', 
            `<style>
                del.diffCls { 
                    background-color: rgb(149, 33, 0); 
                }  
                ins.diffCls { 
                    background-color: rgb(35, 94, 0); 
                }
            </style>`);
    }
}


function CreateWorkItemPageEvents()
{
    // Compare https://github.com/microsoft/azure-devops-extension-sample/blob/6de8a97b53deff86d6863df0ac81561c14bf081b/src/Samples/WorkItemFormGroup/WorkItemFormGroup.tsx#L44
    // for the argument type 'args' of each event.
    return {
        // Called every time the user changes the value of a field; saving is not required for this to be called. So there is no
        // history changed yet. So nothing to do.
        onFieldChanged: function (args) { },

        // Called when the own page is shown (not the page of the work item, but when the user clicked on the tab to open the history diff).
        // Also called when moving up or down a work item in a query of the time work item type; our history tab keeps getting shown in
        // this case, and actually our whole 'instance' (iframe) is not recreated.
        // args = IWorkItemLoadedArgs: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iworkitemloadedargs
        onLoaded: function (args) {
            // On the initial load we do nothing, because we already retrieved everything in InitializeHistoryDiff(). The advantage of doing
            // it there is that we get the 'spinning circle' indicator for free by ADO.
            if (gUnloadedCalled) {
                LoadAndSetDiffInHTMLDocument();
            }
        },

        // Called when moving up or down a work item in a query. The only thing we need to do is to
        // let onLoaded know that it needs to actually get everything again.
        onUnloaded: function (args) {
            gUnloadedCalled = true;
        },

        // Called after the user saved the work item.
        onSaved: function (args) {
            LoadAndSetDiffInHTMLDocument();
        },

        // Not sure when this can be called in practice. So simply get everything again.
        onReset: function (args) {
            LoadAndSetDiffInHTMLDocument();
        },

        // Called when the user clicks on the ADO refresh button.
        onRefreshed: function (args) {
            LoadAndSetDiffInHTMLDocument();
        }
    };
}


// Called when the user opens the new 'History' tab (not called when simply opening a work item, i.e. called
// lazily when actually required). Note that in queries the user can move up and down through the found items,
// and there this function gets called only once for every new work item type (bug, user story, task, etc.)
// encountered. For example, if there are two successive bugs, the user shows the history diff on the first bug,
// then moves on to the next bug, ADO will show immediately our history diff tab, but this function is not called
// again. Instead, the 'onUnloaded' and 'onLoaded' events are called (see CreateWorkItemPageEvents()).
async function InitializeHistoryDiff(adoSDK, adoAPI)
{
    // Called by the ADO API after the client received and applied the ADO theme. Also called when the user changes the theme
    // while our extension is already loaded. The event doesn't seem to be documented, but it can be seen in the source:
    // https://github.com/microsoft/azure-devops-extension-sdk/blob/8dda1027b31c1fbe97ba4d92ee1bf541ed116061/src/SDK.ts#L495
    window.addEventListener('themeApplied', function (data) {
        DetectAndApplyDarkMode();
    });

    // https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-sdk/#azure-devops-extension-sdk-init
    // Options: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-sdk/iextensioninitoptions
    // We set 'loaded' to false, so that ADO shows the "spinning loading indicator" while we get all work item updates.
    adoSDK.init({applyTheme: true, loaded: false});
        
    await adoSDK.ready();

    // Register the actual page shown by ADO.
    // Based on https://learn.microsoft.com/en-us/azure/devops/extend/develop/add-workitem-extension?view=azure-devops-2019#htmljavascript-sample
    // and https://learn.microsoft.com/en-us/azure/devops/extend/develop/add-workitem-extension?view=azure-devops-2019#add-a-page
    // Register function: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-sdk/#functions
    adoSDK.register(adoSDK.getContributionId(), function () {
        return CreateWorkItemPageEvents();
    });

    gAdoSDK = adoSDK;
    gAdoAPI = adoAPI;
    
    await Promise.all([
        InitSharedGlobals(adoSDK, adoAPI),
        LoadConfiguration(adoSDK)
    ]);
    
    InitializeConfigDialog();

    // We first get the work item revisions from ADO, and only then tell ADO that we have loaded successfully.
    // This causes ADO to show the 'spinning loading indicator' until we are ready.
    await LoadAndSetDiffInHTMLDocument();

    adoSDK.notifyLoadSucceeded();
}


// Using 'import' instead of 'require' doesn't work with these two dependencies. The SDK gets bundled
// by webpack twice, which causes an error because the SDK has side effects.
// See https://stackoverflow.com/q/78210363/3740047, https://github.com/microsoft/azure-devops-extension-api/issues/109
// and https://github.com/microsoft/azure-devops-extension-api/pull/126.
require(['azure-devops-extension-sdk', 
         'azure-devops-extension-api'
        ], 
        // @ts-ignore
        function (adoSDK, adoAPI) {
            InitializeHistoryDiff(adoSDK, adoAPI);
        }
);
