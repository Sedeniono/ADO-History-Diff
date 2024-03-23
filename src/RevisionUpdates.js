// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { TryGetHTMLLinkNameAndUrlForArtifactLink } from './ArtifactLinkToURL';
import { gWorkItemRESTClient } from './Globals';
import { EscapeHtml, FormatDate, GetIdentityAvatarHtml, GetIdentityName, RemoveStyle } from './Utils';
// @ts-ignore
import * as htmldiff from 'node-htmldiff';

// An enum that holds the known field types. E.g. FieldTypeEnum.Html === 4.
// It is basically https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/fieldtype,
// except that this documentation is incorrect (it shows the wrong numerical ids). (Apparently, the enum 'FieldType'
// exists several times in the API with different definitions, and the tool that creates the documentation cannot handle it?) 
// The correct one is this:
// https://github.com/microsoft/azure-devops-node-api/blob/fa534aef7d79ab4a30ae2b8823654795b6eed1aa/api/interfaces/WorkItemTrackingInterfaces.ts#L460
import { FieldType as FieldTypeEnum } from 'azure-devops-extension-api/WorkItemTracking';



export async function GetTableInfosForEachRevisionUpdate(revisionUpdates, fieldsPropertiesMap, currentProjectName) 
{
    let allUpdateTables = [];

    for (let revIdx = revisionUpdates.length - 1; revIdx >= 0; --revIdx) {
        // revUpdate = WorkItemUpdate: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemupdate
        const revUpdate = revisionUpdates[revIdx];
        if (!revUpdate) {
            continue;
        }

        const tableInfosOfUpdate = await GetTableInfosForSingleRevisionUpdate(fieldsPropertiesMap, currentProjectName, revUpdate);
        // Note: Table of length 0 is allowed, because we want to merge comment updates with it later on. That way we can display the correct update id.
        if (tableInfosOfUpdate) {
            allUpdateTables.push(tableInfosOfUpdate);
        }
    }

    return allUpdateTables;
}


const hiddenFields = [
    // These change in every revision.
    'System.Rev', 'System.AuthorizedDate', 'System.RevisedDate', 'System.ChangedDate', 'System.Watermark',
    // Fields that are sufficiently represented by the 'System.AreaPath' field.
    'System.AreaId', 'System.NodeName',
    // Fields that are sufficiently represented by the 'System.IterationPath' field.
    'System.IterationId',
    // The work item ID is pretty clear to the user, no need to show it.
    'System.Id',
    // These are the comments on work items, but the updates reported by ADO to the field are unusable.
    // We get the history of comments separately. So filter out the 'System.History' field itself.
    'System.History',
    // Further things that seem unnecessary.
    'Microsoft.VSTS.Common.StateChangeDate', 'System.IsDeleted', 'System.CommentCount', 'System.PersonId', 'System.AuthorizedAs',
    'System.ChangedBy', 'System.CreatedBy'
];


async function GetTableInfosForSingleRevisionUpdate(fieldsPropertiesMap, currentProjectName, revUpdate)
{
    // The work item revision 'revUpdate.rev' seems to get incremented only when a field changes. The 'id' gets 
    // incremented also when a relation is changed.
    const idNumber = EscapeHtml(revUpdate.id);

    // For some reason, 'revUpdate.revisedDate' contains the year 9999 for the newest revision, so we use the 'System.ChangedDate' field.
    // I have also seen intermediate revisions having this problem.
    // Exception: If only a relation is changed but not a field, then 'System.ChangedDate' does not exist. But 'revUpdate.revisedDate' 
    // then seems to contain the correct value.
    const rawChangedDate = revUpdate.fields?.['System.ChangedDate']?.newValue ?? revUpdate.revisedDate;

    let tableRows = [];
    if (revUpdate.fields) {
        for (const [fieldReferenceName, value] of Object.entries(revUpdate.fields)) {
            if (hiddenFields.indexOf(fieldReferenceName) >= 0 
                // 'AreaLevel1', 'AreaLevel2', etc. are sufficiently represented by the 'System.AreaPath' field.
                || fieldReferenceName.indexOf('System.AreaLevel') >= 0
                // 'IterationLevel1', 'IterationLevel2', etc. are sufficiently represented by the 'System.IterationPath' field.
                || fieldReferenceName.indexOf('System.IterationLevel') >= 0) {
                continue;
            }

            // Note that some field types that we can get from the WorkItemTrackingRestClient.getUpdates() function do not appear in 
            // the map of known types. I have seen e.g. WEF_2091CE2F93FB4861B19151BC9013A908_Kanban.Column.
            // No idea what these additional fields are for, but it seems that they are duplicates of other fields?
            // For the above 'Kanban' example, there is also 'System.BoardColumn' with apparently the same information?
            // For simplicity, we won't display them (because what should we display as 'friendly' field name?).
            // Also, such 'WEF_' fields actually randomly appear anyway in the map of known types every know and then, but after 
            // a refresh they are gone. So filter them always.
            const isWEF = fieldReferenceName.lastIndexOf('WEF_', 0) === 0;
            if (isWEF) {
                continue;
            }
            else if (!fieldsPropertiesMap.hasOwnProperty(fieldReferenceName)) {
                console.log(`HistoryDiff: Update with id ${idNumber} (change date: ${rawChangedDate}) contains unknown field '${fieldReferenceName}'. Not showing its changes.`);
                continue;
            }
        
            const fieldDiff = GetDiffFromUpdatedField(fieldsPropertiesMap, fieldReferenceName, value);
            if (fieldDiff) {
                // Note: The key of the properties (i.e. the 'fieldReferenceName') is the 'referenceName' of the field type from the
                // WorkItemField interface (https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemfield#azure-devops-extension-api-workitemfield-referencename).
                // It is some identifier not intended for display. So we get a better name from the API.
                const friendlyFieldName = GetFriendlyFieldName(fieldsPropertiesMap, fieldReferenceName);
                if (friendlyFieldName) {
                    tableRows.push([friendlyFieldName, fieldDiff]);
                }
            }
        }
    }

    if (revUpdate.relations) {
        if (revUpdate.relations.added) {
            for (const relation of revUpdate.relations.added) {
                const changeStrings = await GetUserFriendlyStringsForRelationChange(currentProjectName, relation);
                if (typeof changeStrings !== 'undefined') {
                    const [friendlyName, change] = changeStrings;
                    // Note: The comment text is the *latest* version of the comment, i.e. not the comment text with
                    // which the link got added if the comment text got edited later. We still show it.
                    // Apparently, ADO does not keep track of the link comment edits, so this is the best we can do.
                    let commentHtml = '';
                    if (relation.attributes?.comment) {
                        commentHtml = `<br><i>Newest link comment:</i> <ins class="diffCls">${EscapeHtml(relation.attributes.comment)}</ins>`;
                    }
                    tableRows.push([`Link added: ${friendlyName}`, `<ins class="diffCls">${change}</ins>${commentHtml}`]);
                }
            }
        }
        if (revUpdate.relations.removed) {
            for (const relation of revUpdate.relations.removed) {
                const changeStrings = await GetUserFriendlyStringsForRelationChange(currentProjectName, relation);
                if (typeof changeStrings !== 'undefined') {
                    const [friendlyName, change] = changeStrings;
                    tableRows.push([`Link removed: ${friendlyName}`, `<del class="diffCls">${change}</del>`]);
                }
            }                
        }
        // Note: I couldn't find a case where the 'relations.updated' array exists.
        // There is this REST API: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-server-rest-5.0&tabs=HTTP#update-a-link
        // But trying it, either that API throws an error, or ignores requested changes to the links, or it does
        // change a few things (especially the link's comment) but then the change does not appear in the 'updated' 
        // array anyway. Also see: https://developercommunity.visualstudio.com/t/unable-to-update-a-hyperlink-in-a-work-item-via-re/1037054
        if (revUpdate.relations.updated) {
            for (const relation of revUpdate.relations.updated) {
                const changeStrings = await GetUserFriendlyStringsForRelationChange(currentProjectName, relation);
                if (typeof changeStrings !== 'undefined') {
                    const [friendlyName, change] = changeStrings;
                    tableRows.push([`Link updated: ${friendlyName}`, `<ins class="diffCls">${change}</ins>`]);
                }
            }
        }
    }

    return {
        authorIdentity: revUpdate.revisedBy,
        changedDate: rawChangedDate,
        tableRows: tableRows,
        idNumber: idNumber
    };
}


// Returns [friendlyName, value], where 'friendlyName' is a user displayable name of the given relation, and
// the 'value' is a string containing the displayable value of the relation.
async function GetUserFriendlyStringsForRelationChange(currentProjectName, relation)
{
    if (!relation) {
        return undefined;
    }

    // Compare https://learn.microsoft.com/en-us/azure/devops/boards/queries/link-type-reference for some information on the possible
    // values of 'relation.rel'.
    const relType = relation.rel;
    if (relType === 'Hyperlink') {
        const friendlyName = 'Hyperlink';
        const value = `<a href="${relation.url}" target="_parent">${EscapeHtml(relation.url)}</a>`;
        return [friendlyName, value];
    }
    else if (relType === 'ArtifactLink') {
        // Link to some repository artifact (commit, pull request, branch, etc.), build artifact, wiki page, etc.
        const friendlyName = EscapeHtml(relation.attributes?.name);
        const data = await TryGetHTMLLinkNameAndUrlForArtifactLink(currentProjectName, relation.url);
        if (!data) {
            // Unknown or broken artifact link: Simply display the raw url.
            return [friendlyName, EscapeHtml(relation.url)];
        }
        const [displayText, url, additionalInfo] = data;
        let value = url ? `<a href="${url}" target="_parent">${EscapeHtml(displayText)}</a>` : EscapeHtml(displayText);
        if (additionalInfo) {
            value = `${EscapeHtml(additionalInfo)}: ${value}`;
        }
        return [friendlyName, value];
    }
    else if (relType === 'AttachedFile') {
        const friendlyName = 'Attachment';
        const rawFilename = relation.attributes?.name;
        if (rawFilename) {
            const htmlFilename = EscapeHtml(rawFilename);
            const urlFilename = encodeURIComponent(rawFilename);
            // The 'relation.url' matches with the REST API:
            // https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/attachments/get?view=azure-devops-rest-5.1
            // We add the 'fileName' parameter so that the downloaded file has the correct name; otherwise, it would be some GUID-like string.
            // Also, we enforce the download because otherwise a video file would completely replace the extension's iframe.
            const value = `<a href="${relation.url}?fileName=${urlFilename}&download=true">${htmlFilename}</a>`;
            return [friendlyName, value];
        }
        else {
            return [friendlyName, '(Unknown file.)'];
        }
    }

    // For work item links, the relation.rel value can be one of quite a bunch. So we detect it by the relation.url.
    // E.g.: http://<Host>/<Collection>/2d63f741-0ba0-4bc6-b730-896745fab2c0/_apis/wit/workItems/2
    const workItemApiFragment = '/_apis/wit/workItems/';
    const apiURL = String(relation.url);
    const workItemFragmentIdx = apiURL.indexOf(workItemApiFragment);
    if (workItemFragmentIdx >= 0 && apiURL.indexOf('http') == 0) {
        const friendlyName = EscapeHtml(relation.attributes?.name);
        const linkedItemNumber = apiURL.substring(workItemFragmentIdx + workItemApiFragment.length);
        const linkName = EscapeHtml(`Work item #${linkedItemNumber}`);
        // 'relation.url' contains the REST API link. There seems to be no official API to convert it to a link that
        // the user can click properly. But a simple replacement does the job.
        const userFriendlyURL = apiURL.replace(workItemApiFragment, '/_workitems/edit/');
        const value = `<a href="${userFriendlyURL}" target="_parent">${linkName}</a>`;
        return [friendlyName, value];
    }
    
    // TODO: Remote work links types (links between organizations).
    return ['(Unsupported link type)', '(Showing the change is not supported.)'];
}


function DiffHtmlText(oldValue, newValue) 
{
    // Remove <style> in the html content: Having it in the <body> is illegal. ADO itself doesn't insert them
    // (as far as I know), but some tools (e.g. JIRA to ADO conversion scripts) might insert them. Also, you can
    // edit e.g. the description field in the browser's debugger and insert any html there, and ADO apparently
    // stores it in its database. Thus, we end up getting <style> here, too. ADO itself actually also removes the 
    // <style> tag when loading a work item in the UI.
    const oldValueFixed = RemoveStyle(oldValue ?? '');
    const newValueFixed = RemoveStyle(newValue ?? '');
    return htmldiff(oldValueFixed, newValueFixed, 'diffCls'); 
}


function GetDiffFromUpdatedField(fieldsPropertiesMap, fieldReferenceName, value)
{
    if (typeof value?.oldValue === 'undefined' && typeof value?.newValue === 'undefined') {
        return undefined;
    }

    if (fieldReferenceName === 'Microsoft.VSTS.TCM.Steps') {
        // The steps of a test case show up as a field of type 'FieldTypeEnum.Html', which is lie. It does not contain valid html that 
        // a browser can display. It seems to be simply XML, with each individual step description being (escaped) html.
        // TODO: Can we still show a meaningful proper diff?
        // https://devblogs.microsoft.com/devops/how-to-use-test-step-using-rest-client-helper/
        // https://oshamrai.wordpress.com/2019/05/11/azure-devops-services-rest-api-14-create-and-add-test-cases-2/
        // ADO probably parses it in TestBase.getTestStepsInternal() in TestManagement\Scripts\TFS.TestManagement.js.
        return '(Showing the diff of test case steps is not supported.)';
    }
    else if (fieldReferenceName === 'Microsoft.VSTS.TCM.Parameters') {
        // This field is used in 'shared parameter set' work items, which are work items that can be referenced by test case items.
        // https://learn.microsoft.com/en-us/azure/devops/test/repeat-test-with-different-data?view=azure-devops#share-parameters-between-test-cases
        // The field type is reported as 'FieldTypeEnum.Html', although in reality it is some general XML. For example:
        //    "<parameterSet><paramNames><param>someVar</param><param>var</param></paramNames><paramData lastId=\"1\"><dataRow id=\"1\"><kvp key=\"someVar\" value=\"test value\"/><kvp key=\"var\" value=\"another value\"/></dataRow></paramData></parameterSet>"
        return '(Showing the diff of a shared parameter set is not supported.)';
    }
    else if (fieldReferenceName === 'Microsoft.VSTS.TCM.LocalDataSource') {
        // Similar to the two cases above, this field is used in test case work items. It contains parameter values. And as the 
        // other fields, it is reported to contain HTML, which is again a lie. For local parameters it is again some XML string. 
        // Insidiously, for shared parameters it seems to contain data in JSON.
        return '(Showing the diff of parameter values is not supported.)';
    }

    // Azure DevOps (at least 2019) reports identities (e.g. the 'System.CreatedBy' field) as 'FieldTypeEnum.String', but the 'isIdentity' flag is set.
    // An identity is probably an 'IdentityReference': https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/identityreference
    let fieldType = fieldsPropertiesMap?.[fieldReferenceName]?.type;
    if (fieldsPropertiesMap?.[fieldReferenceName]?.isIdentity) {
        fieldType = FieldTypeEnum.Identity;
    }
    // Note for picklists: It seems that they are used only for user-added fields. They appear as combo boxes.
    // Similar to identities, picklists are also identified via an additional flag in the 'WorkItemField' interface. So PicklistString,
    // PicklistDouble and PicklistInteger shouldn't appear in the switch below. Moreover, for some reason the 'isPicklist' property is missing 
    // in the elements returned by IWorkItemFormService.getFields() (https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iworkitemformservice#azure-devops-extension-api-iworkitemformservice-getfields).
    // i.e. in the data stored in 'fieldsPropertiesMap'. Fortunately, we do not really need to know whether it is a picklist or not: We can
    // simply treat picklists as a string/integer/double.

    switch (fieldType) {
        case FieldTypeEnum.Html:
            return DiffHtmlText(value.oldValue, value.newValue);
            
        // 'History' means the comments. Unfortunately, they are quite special: When a user adds a new comment, it shows
        // up in the work item updates in the 'newValue'. The value itself is html. The 'oldValue' contains the value of 
        // the previously added comment. So computing a diff makes no sense. If a user edits a comment, it does generate 
        // a work item update element, but without any usable information (especially no 'System.History' entry). Instead, 
        // the **original** update which added the comment suddenly has changed and displays the new edited value.
        // => We actually filter out the 'System.History' entry somewhere else. I think that apart from 'System.History',
        // no other field can use the 'History' field type. Hence, this code here is probably dead. We have dedicated REST
        // API requests somewhere else to get the history of comments.
        case FieldTypeEnum.History:
            return value.hasOwnProperty('newValue') ? `<ins class="diffCls">${RemoveStyle(value.newValue)}</ins>` : '';

        case FieldTypeEnum.String:
        case FieldTypeEnum.PlainText:
        {
            // We simply feed htmldiff the values with escaped special characters, meaning that htmldiff should not see any HTML elements.
            // Using a different diff-library (jsdiff or diff-match-patch) is not worth the additional dependency, since the only work item
            // fields that contain a significant amount of text are html elements.
            // But beforehand we replace newline characters with '<br>' to get a good diff if line breaks exist. By default, ADO uses a 
            // single line for 'String' and 'PlainText' fields. However, we want to support extensions such as
            // https://marketplace.visualstudio.com/items?itemName=krypu.multiline-plain-text-field that do display multiple lines.
            const newLineRegex = /(?:\r\n|\r|\n)/g;
            const oldValue = EscapeHtml(value.oldValue ?? '').replace(newLineRegex, '<br>');
            const newValue = EscapeHtml(value.newValue ?? '').replace(newLineRegex, '<br>');
            const diff = htmldiff(oldValue, newValue, 'diffCls');
            return diff;
        }

        case FieldTypeEnum.Integer:
        case FieldTypeEnum.PicklistInteger: // See note above: Shouldn't appear, but if it does, can be treated as integer.
        case FieldTypeEnum.Double:
        case FieldTypeEnum.PicklistDouble: // See note above: Shouldn't appear, but if it does, can be treated as double.
        case FieldTypeEnum.PicklistString: // See note above: Shouldn't appear, but if it does, can be treated as string.
        case FieldTypeEnum.Guid: // Guids are given as plain strings.
        case FieldTypeEnum.Boolean:
        case FieldTypeEnum.TreePath:
            return (value.hasOwnProperty('oldValue') ? `<del class="diffCls">${EscapeHtml(value.oldValue)}</del>` : '') 
                + (value.hasOwnProperty('newValue') ? `<ins class="diffCls">${EscapeHtml(value.newValue)}</ins>` : '');

        case FieldTypeEnum.DateTime:
            return (value.hasOwnProperty('oldValue') ? `<del class="diffCls">${FormatDate(value.oldValue)}</del>` : '') 
                + (value.hasOwnProperty('newValue') ? `<ins class="diffCls">${FormatDate(value.newValue)}</ins>` : '');

        case FieldTypeEnum.Identity:
            return (value.hasOwnProperty('oldValue') ? `<del class="diffCls">${FormatIdentityForFieldDiff(value.oldValue)}</del>` : '') 
                + (value.hasOwnProperty('newValue') ? `<ins class="diffCls">${FormatIdentityForFieldDiff(value.newValue)}</ins>` : '');

        default:
            console.log(`HistoryDiff: Unknown field type '${fieldType}' (${FieldTypeEnum?.[fieldType]}), oldValueType: ${typeof value.oldValue}, newValueType: ${typeof value.newValue}`);
            return undefined;
    }
}


function GetFriendlyFieldName(fieldsPropertiesMap, fieldReferenceName) 
{
    // The 'System.History' field represents the comments, but is named 'history' (probably for historic reasons).
    if (fieldReferenceName === 'System.History') {
        return 'Comment';
    }

    return EscapeHtml(fieldsPropertiesMap?.[fieldReferenceName].name);
}


function FormatIdentityForFieldDiff(identity)
{
    if (!identity) {
        return null;
    }

    const changedByName = GetIdentityName(identity);
    if (!changedByName) {
        return 'UNKNOWN_NAME';
    }

    const avatarHtml = GetIdentityAvatarHtml(identity);
    return `${avatarHtml} ${changedByName}`
}


// Returns a promise for an array of 'WorkItemUpdate': https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemupdate
// Each 'WorkItemUpdate' element contains information about the difference to the previous revision.
export async function GetAllRevisionUpdates(workItemId, projectName)
{
    // getRevisions(): https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient#azure-devops-extension-api-workitemtrackingrestclient-getrevisions
    //   3rd parameter 'top': How many work items to get from the beginning. E.g. top=5 gets the 5 earliest revisions.
    //   4th parameter 'skip': How many work items to skip at the beginning. E.g. skip=5 skips the earliest 5 revisions.
    //   5th parameter 'expand': https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemexpand
    //      Most additional information looks uninteresting.
    //      Except maybe the parameter 'Relations'=1, which seems to include changes in the 'related to' links.
    // Resulting REST queries:
    //   http://<Host>/<Collection>/<Project>/_apis/wit/workItems/2/revisions
    //   http://<Host>/<Collection>/<Project>/_apis/wit/workItems/2/revisions?%24top=5
    //   http://<Host>/<Collection>/<Project>/_apis/wit/workItems/2/revisions?%24skip=3
    //   http://<Host>/<Collection>/<Project>/_apis/wit/workItems/3/revisions?%24expand=1
    //   http://<Host>/<Collection>/<Project>/_apis/wit/workItems/3/revisions?%24top=3&%24skip=4
    //return gWorkItemRESTClient.getRevisions(workItemId, projectName);

    // getUpdates(): https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient#azure-devops-extension-api-workitemtrackingrestclient-getupdates
    // Examples of a resulting REST query:
    //   http://<Host>/<Collection>/<Project>/_apis/wit/workItems/4/updates
    // Otherwise behaves the same as getRevisions().
    //
    // ADO usually returns at most 200 elements. So we need a loop that successively requests elements, until ADO no longer
    // sends us any more elements.
    // TODO: Maybe using actual pages would be nicer for the user/bandwidth if there are many updates. But I guess it is very rare
    // that any work item has thousands of updates?
    let all = [];
    while (true) {
        const skip = all.length;
        const curBatch = await gWorkItemRESTClient.getUpdates(workItemId, projectName, undefined, skip);
        if (!curBatch || !curBatch.hasOwnProperty('length') || curBatch.length == 0) {
            break;
        }

        all.push.apply(all, curBatch);
    }
    
    return all;
}

