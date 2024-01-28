/*
MIT License

Copyright (c) 2024 Sedenion

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

GitHub link: https://github.com/Sedeniono/ADO-History-Diff
*/

// @ts-check

var gAdoSDK;
var gAdoAPI;
var gHtmlDiff;
var gWorkItemFormServiceId;
var gWorkItemTracking;

// WorkItemTrackingRestClient: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient
var gWorkItemRESTClient;

// An enum that holds the known field types. E.g. gFieldTypeEnum.Html === 4.
// It is basically https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/fieldtype,
// except that this documentation is incorrect (it shows the wrong numerical ids). (Apparently, the enum 'FieldType'
// exists several times in the API with different definitions, and the tool that creates the documentation cannot handle it?) 
// The correct one is this:
// https://github.com/microsoft/azure-devops-node-api/blob/fa534aef7d79ab4a30ae2b8823654795b6eed1aa/api/interfaces/WorkItemTrackingInterfaces.ts#L460
var gFieldTypeEnum;

var gUnloadedCalled = false;


const gReplaceEntityMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;'
  };
  
// Escapes some piece of text so that it can be safely put into an html element.
// https://stackoverflow.com/a/12034334/3740047
function EscapeHtml(string) {
    return String(string).replace(/[&<>"'`=\/]/g, function (s) {
        return gReplaceEntityMap[s];
    });
}


const gStyleRegex = /\<style\>.*?\<\/style\>/gms;

function RemoveStyle(string) 
{
    return String(string).replace(gStyleRegex, '');
}


function GetHtmlDisplayField()
{
    const elem = document.getElementById('htmlDivDiff');
    if (!elem) {
        throw new Error('HistoryDiff: HTML element not found.');
    }
    return elem;
}


function SetHtmlToLoading()
{
    GetHtmlDisplayField().innerHTML = '<b>Loading history...</b>';
}


function FormatDate(date)
{
    const dateFormatOptions = {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false};
    return date.toLocaleDateString(undefined, dateFormatOptions);
}


function GetIdentityName(identity) 
{
    return EscapeHtml(identity?.displayName ?? 'UNKNOWN NAME');
}


function GetIdentityAvatarHtml(identity) 
{
    // According to the documentation (https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/identityreference),
    // 'imageUrl' is deprecated and '_links.avatar' should be used.
    const avatarUrl = identity?._links?.avatar?.href ?? '';
    const avatarHtml = avatarUrl ? `<img src="${avatarUrl}" class="inlineAvatar" alt="Avatar">` : '';
    return avatarHtml;
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


function GetTableInfosForEachRevisionUpdate(revisionUpdates, fieldsPropertiesMap) 
{
    let allUpdateTables = [];

    for (let revIdx = revisionUpdates.length - 1; revIdx >= 0; --revIdx) {
        // revUpdate = WorkItemUpdate: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemupdate
        const revUpdate = revisionUpdates[revIdx];
        if (!revUpdate) {
            continue;
        }

        const tableInfosOfUpdate = GetTableInfosForSingleRevisionUpdate(fieldsPropertiesMap, revUpdate);
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


function GetTableInfosForSingleRevisionUpdate(fieldsPropertiesMap, revUpdate)
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
                // 'IterationLevel1', 'IterationLevel2', etc. are sufficiently represented by the 'System.AreaPath' field.
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
        // TODO: What about the comment on a relation? Show it? What about that link comment's history?
        if (revUpdate.relations.added) {
            for (const relation of revUpdate.relations.added) {
                const changeStrings = GetUserFriendlyStringsOfRelationChange(relation);
                if (typeof changeStrings !== 'undefined') {
                    const [friendlyName, change] = changeStrings;
                    tableRows.push([`Link added: ${friendlyName}`, `<ins class="diffCls">${change}</ins>`]);
                }
            }
        }
        if (revUpdate.relations.removed) {
            for (const relation of revUpdate.relations.removed) {
                const changeStrings = GetUserFriendlyStringsOfRelationChange(relation);
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
                const changeStrings = GetUserFriendlyStringsOfRelationChange(relation);
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
function GetUserFriendlyStringsOfRelationChange(relation)
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

        const friendlyName = relation.attributes?.name;

        // TODO: Need to figure out how to convert the relation.url to a user friendly link. I think we need to parse it manually.
        // See e.g. https://developercommunity.visualstudio.com/t/artifact-uri-format-in-external-link-of-work-items/964448
        // The relation.url is e.g.: 
        //  - Repo link: vstfs:///Git/Ref/2d63f741-0ba0-4bc6-b730-896745fab2c0%2Fc0d1232d-66e9-4d5e-b5a0-50366bc67991%2FGBmain
        //  - Build link: vstfs:///Build/Build/1
        //  - Wiki page: vstfs:///Wiki/WikiPage/2d63f741-0ba0-4bc6-b730-896745fab2c0%2F201005d4-3f97-4766-9b82-b69c89972e64%2FFirst%20wiki%20page
        const value = '(Showing the change is not supported.)';
        return [friendlyName, value];
    }
    else if (relType === 'AttachedFile') {
        const friendlyName = 'Attachment';
        const rawFilename = relation.attributes?.name;
        if (rawFilename) {
            const filename = EscapeHtml(rawFilename);
            // TODO: The filename on the server (i.e. the file pointed to by relation.url) is some GUID. So browsers will download the file
            // with that GUID as filename. The 'download' attribute of <a> should change the filename of the downloaded file to the correct one, but
            // this did not work in my tests (neither in Edge nor Firefox). Googling this, usually there are 2 reasons why this happens: First, 
            // when the url has a different origin. But this is not the case here. (The relation.url is absolute, but even converting it to
            // a relative one does not help in my tests.) Second, if the http header of the download contains the 'Content-Disposition'
            // header with a 'filename'. The 'Content-Disposition' is actually set by ADO, but without a filename, so I think this is also
            // not the reason. Weird.
            const value = `<a href="${relation.url}" download="${rawFilename}">${filename}</a>`;
            return [friendlyName, value];
        }
        else {
            return [friendlyName, '(Unknown file.)'];
        }
    }

    // For work item links, the relation.rel value can be one of quite a bunch. So we detect it by the relation.url.
    // E.g.: http://<host>/DefaultCollection/2d63f741-0ba0-4bc6-b730-896745fab2c0/_apis/wit/workItems/2
    const workItemApiFragment = '/_apis/wit/workItems/';
    const apiURL = String(relation.url);
    const workItemFragmentIdx = apiURL.indexOf(workItemApiFragment);
    if (workItemFragmentIdx >= 0 && apiURL.indexOf('http') == 0) {
        const friendlyName = relation.attributes?.name;
        const linkedItemNumber = apiURL.substring(workItemFragmentIdx + workItemApiFragment.length);
        const linkName = EscapeHtml(`Work item #${linkedItemNumber}`);
        // 'relation.url' contains the REST API link. There seems to be no official API to convert it to a link that
        // the user can click properly. But a simple replacement does the job.
        const userFriendlyURL = apiURL.replace(workItemApiFragment, '/_workitems/edit/');
        const value = `<a href="${userFriendlyURL}" target="_parent">${linkName}</a>`;
        return [friendlyName, value];
    }
    
    // TODO: Haven't tested github links, remote work links types (links between organizations), links to storyboards, links to tests.
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
    return gHtmlDiff(oldValueFixed, newValueFixed, 'diffCls'); 
}


function GetDiffFromUpdatedField(fieldsPropertiesMap, fieldReferenceName, value)
{
    if (typeof value?.oldValue === 'undefined' && typeof value?.newValue === 'undefined') {
        return undefined;
    }

    if (fieldReferenceName === 'Microsoft.VSTS.TCM.Steps') {
        // The steps of a test case show up as a field of type 'gFieldTypeEnum.Html', which is lie. It does not contain valid html that 
        // a browser can display. It seems to be simply XML, with each individual step description being (escaped) html.
        // TODO: Can we still show a meaningful proper diff?
        // https://devblogs.microsoft.com/devops/how-to-use-test-step-using-rest-client-helper/
        // https://oshamrai.wordpress.com/2019/05/11/azure-devops-services-rest-api-14-create-and-add-test-cases-2/
        return '(Showing the diff of test case steps is not supported.)';
    }

    // Azure DevOps (at least 2019) reports identities (e.g. the 'System.CreatedBy' field) as 'gFieldTypeEnum.String', but the 'isIdentity' flag is set.
    // An identity is probably an 'IdentityReference': https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/identityreference
    let fieldType = fieldsPropertiesMap?.[fieldReferenceName]?.type;
    if (fieldsPropertiesMap?.[fieldReferenceName]?.isIdentity) {
        fieldType = gFieldTypeEnum.Identity;
    }
    // Note for picklists: It seems that they are used only for user-added fields. They appear as combox boxes.
    // Similar to identities, picklists are also identified via an additional flag in the 'WorkItemField' interface. So PicklistString,
    // PicklistDouble and PicklistInteger shouldn't appear in the switch below. Moreover, for some reason the 'isPicklist' property is missing 
    // in the elements returned by IWorkItemFormService.getFields() (https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iworkitemformservice#azure-devops-extension-api-iworkitemformservice-getfields).
    // i.e. in the data stored in 'fieldsPropertiesMap'. Fortunately, we do not really need to know whether it is a picklist or not: We can
    // simply treat picklists as a string/integer/double.

    switch (fieldType) {
        case gFieldTypeEnum.Html:
            return DiffHtmlText(value.oldValue, value.newValue);
            
        // 'History' means the comments. Unfortunately, they are quite special: When a user adds a new comment, it shows
        // up in the work item updates in the 'newValue'. The value itself is html. The 'oldValue' contains the value of 
        // the previously added comment. So computing a diff makes no sense. If a user edits a comment, it does generate 
        // a work item update element, but without any usable information (especially no 'System.History' entry). Instead, 
        // the **original** update which added the comment suddenly has changed and displays the new edited value.
        // => We actually filter out the 'System.History' entry somewhere else. I think that apart from 'System.History',
        // no other field can use the 'History' field type. Hence, this code here is probably dead. We have dedicated REST
        // API requests somewhere else to get the history of comments.
        case gFieldTypeEnum.History:
            return value.hasOwnProperty('newValue') ? `<ins class="diffCls">${RemoveStyle(value.newValue)}</ins>` : '';

        case gFieldTypeEnum.String:
        case gFieldTypeEnum.PlainText:
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
            const diff = gHtmlDiff(oldValue, newValue, 'diffCls');
            return diff;
        }

        case gFieldTypeEnum.Integer:
        case gFieldTypeEnum.PicklistInteger: // See note above: Shouldn't appear, but if it does, can be treated as integer.
        case gFieldTypeEnum.Double:
        case gFieldTypeEnum.PicklistDouble: // See note above: Shouldn't appear, but if it does, can be treated as double.
        case gFieldTypeEnum.PicklistString: // See note above: Shouldn't appear, but if it does, can be treated as string.
        case gFieldTypeEnum.Guid: // Guids are given as plain strings.
        case gFieldTypeEnum.Boolean:
        case gFieldTypeEnum.TreePath:
            return (value.hasOwnProperty('oldValue') ? `<del class="diffCls">${EscapeHtml(value.oldValue)}</del>` : '') 
                + (value.hasOwnProperty('newValue') ? `<ins class="diffCls">${EscapeHtml(value.newValue)}</ins>` : '');

        case gFieldTypeEnum.DateTime:
            return (value.hasOwnProperty('oldValue') ? `<del class="diffCls">${FormatDate(value.oldValue)}</del>` : '') 
                + (value.hasOwnProperty('newValue') ? `<ins class="diffCls">${FormatDate(value.newValue)}</ins>` : '');

        case gFieldTypeEnum.Identity:
            return (value.hasOwnProperty('oldValue') ? `<del class="diffCls">${FormatIdentityForFieldDiff(value.oldValue)}</del>` : '') 
                + (value.hasOwnProperty('newValue') ? `<ins class="diffCls">${FormatIdentityForFieldDiff(value.newValue)}</ins>` : '');

        default:
            console.log(`HistoryDiff: Unknown field type '${fieldType}' (${gFieldTypeEnum?.[fieldType]}), oldValueType: ${typeof value.oldValue}, newValueType: ${typeof value.newValue}`);
            return undefined;
    }
}


function GetFriendlyFieldName(fieldsPropertiesMap, fieldReferenceName) 
{
    // The 'System.History' field represents the comments, but is named 'history' (probably for historic reasons).
    if (fieldReferenceName === 'System.History') {
        return 'Comment';
    }

    return fieldsPropertiesMap?.[fieldReferenceName].name;
}


// Returns a promise for an array of 'WorkItemUpdate': https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemupdate
// Each 'WorkItemUpdate' element contains information about the difference to the previous revision.
async function GetAllRevisionUpdates(workItemId, projectName)
{
    // getRevisions(): https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient#azure-devops-extension-api-workitemtrackingrestclient-getrevisions
    //   3rd parameter 'top': How many work items to get from the beginning. E.g. top=5 gets the 5 earliest revisions.
    //   4th parameter 'skip': How many work items to skip at the beginning. E.g. skip=5 skips the earliest 5 revisions.
    //   5th parameter 'expand': https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemexpand
    //      Most additional information looks uninteresting.
    //      Except maybe the parameter 'Relations'=1, which seems to include changes in the 'related to' links.
    // Resulting REST queries:
    //   http://<host>/DefaultCollection/TestProject/_apis/wit/workItems/2/revisions
    //   http://<host>/DefaultCollection/TestProject/_apis/wit/workItems/2/revisions?%24top=5
    //   http://<host>/DefaultCollection/TestProject/_apis/wit/workItems/2/revisions?%24skip=3
    //   http://<host>/DefaultCollection/TestProject/_apis/wit/workItems/3/revisions?%24expand=1
    //   http://<host>/DefaultCollection/TestProject/_apis/wit/workItems/3/revisions?%24top=3&%24skip=4
    //return gWorkItemRESTClient.getRevisions(workItemId, projectName);

    // getUpdates(): https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient#azure-devops-extension-api-workitemtrackingrestclient-getupdates
    // Examples of a resulting REST query:
    //   http://<host>/DefaultCollection/TestProject/_apis/wit/workItems/4/updates
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


// Artificial id used for comment updates.
const COMMENT_UPDATE_ID = 'COMMENT';


function GetTableInfosForEachComment(comments)
{
    let allCommentTables = [];

    for (const comment of comments) {
        if (!comment || !comment.allUpdates) {
            continue;
        }

        // Ensure sorting from oldest to newest.
        comment.allUpdates.sort((a, b) => a.version - b.version);

        for (let idx = 0; idx < comment.allUpdates.length; ++idx) {
            const curVersion = comment.allUpdates[idx];
            const prevVersion = idx !== 0 ? comment.allUpdates[idx - 1] : null;

            const curText = curVersion?.isDeleted ? '' : curVersion?.text;
            const prevText = prevVersion?.isDeleted ? '' : prevVersion?.text;
            const textChange = DiffHtmlText(prevText, curText);

            let action = '';
            if (idx === 0) {
                action = 'created';
            }
            else if (curVersion?.isDeleted && !prevVersion?.isDeleted) {
                action = 'deleted';
            }
            else {
                action = 'edited';
            }

            // For consistency with the other updates, each comment update gets its own table. So the table consists of only one row.
            // (Except if we merge it later on with another update.)
            const tableRows = [[`Comment ${action}`, textChange]];

            allCommentTables.push({
                authorIdentity: curVersion.modifiedBy,
                changedDate: curVersion.modifiedDate,
                tableRows: tableRows,
                idNumber: COMMENT_UPDATE_ID
            });
        }
    }

    return allCommentTables;
}


// Returns an array 'Comment[]', as described here: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments?view=azure-devops-rest-5.1
// However, every 'Comment' element contains an additional property 'allUpdates' that is an array of all versions of the comment.
async function GetCommentsWithHistory(workItemId, projectName)
{
    // Note: In contrast to getUpdates(), apparently the REST request is not paged. It returns always all comments by default.
    const allComments = await gWorkItemRESTClient.getComments_Patched(
        workItemId, projectName, /*expand*/ 'none', undefined, /*includeDeleted*/ true);
    
    if (!allComments || !allComments.comments || allComments.comments.length == 0) {
        return [];
    }

    let commentsAwaiting = [];
    let versionsPromises = [];

    for (const comment of allComments.comments) {
        // If there is more than one version, start the request for all versions of the comment. We will await the
        // answer for all comments simultaneously below.
        if (comment?.version > 1 && comment?.id) {
            // Note: In contrast to getUpdates(), apparently the REST request is not paged. It returns always all versions by default.
            const versionsPromise = gWorkItemRESTClient.getCommentsVersions_Patched(workItemId, projectName, comment.id);
            commentsAwaiting.push(comment);
            versionsPromises.push(versionsPromise);
        }
        else {
            comment.allUpdates = [comment];
        }
    }

    if (commentsAwaiting.length > 0) {
        const allVersions = await Promise.all(versionsPromises);
        for (let idx = 0; idx < commentsAwaiting.length; ++idx) {
            commentsAwaiting[idx].allUpdates = allVersions[idx];
        }
    }

    return allComments.comments;
}



function GetFullUpdateTables(comments, revisionUpdates, fieldsPropertiesMap)
{
    const tablesForRevisionUpdates = GetTableInfosForEachRevisionUpdate(revisionUpdates, fieldsPropertiesMap);
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
    // http://<host>/DefaultCollection/TestProject/_apis/wit/fields (compare https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/fields/list)
    // (there is also e.g. http://<host>/DefaultCollection/TestProject/_apis/wit/workitemtypes/issue/fields, 
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
    // Note stored as global variable during initialization because the instance is tied to a certain work item,
    // and when the 'onLoaded' event is called, we might have switched to another work item. So need to get it again.
    const [workItemFormService, projectName] = await Promise.all([
        gAdoSDK.getService(gWorkItemFormServiceId), 
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

    const allUpdateTables = GetFullUpdateTables(comments, revisionUpdates, fieldsPropertiesMap);
    const htmlString = CreateHTMLForAllUpdates(allUpdateTables);
    GetHtmlDisplayField().innerHTML = htmlString;
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
    tableRows.sort((a, b) => a[0].localeCompare(b[0]));

    const changedByName = GetIdentityName(updateInfo.authorIdentity);
    const avatarHtml = GetIdentityAvatarHtml(updateInfo.authorIdentity);
    const changedDateStr = updateInfo.changedDate ? FormatDate(updateInfo.changedDate) : 'an unknown date';
    const idStr = (updateInfo.idNumber && updateInfo.idNumber !== COMMENT_UPDATE_ID) ? ` (update ${updateInfo.idNumber})` : '';

    let s = `<div class="changeHeader">${avatarHtml} <b>${changedByName}</b> changed on <i>${changedDateStr}</i>${idStr}:</div>`;
    let tableRowsStr = '';
    for (const [friendlyName, diff] of tableRows) {
        tableRowsStr += `<tr class="diffCls"><td class="diffCls">${friendlyName}</td><td class="diffCls">${diff}</td></tr>`
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
                // TODO: Would be more efficient to not load everything again if the user goes back to a previous work item in the query view.
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
            // TODO: It would be more efficient to just get the latest update, not everything again.
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


function PatchWorkItemTrackingRestClient(WorkItemTrackingRestClient)
{
    // getComments() from the azure-devops-extension-api (at least until version 4.230.0) uses api-version=5.0-preview.2, which 
    // doesn't allow to query deleted comments. But we need that. So we define a custom function that uses the newer REST API version 5.1.
    // So our function corresponds to this REST request: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments?view=azure-devops-rest-5.1
    // The implementation is a copy & paste of the original getComments() javascript code, with proper adaptions.
    WorkItemTrackingRestClient.prototype.getComments_Patched = function (id, project, expand, top, includeDeleted, order) {
        // @ts-ignore
        return __awaiter(this, void 0, void 0, function () {
            var queryValues;
            // @ts-ignore
            return __generator(this, function (_a) {
                queryValues = {
                    '$expand': expand,
                    '$top': top,
                    includeDeleted: includeDeleted,
                    order: order
                };
                return [2 /*return*/, this.beginRequest({
                        apiVersion: '5.1-preview.3',
                        routeTemplate: '{project}/_apis/wit/workItems/{id}/comments',
                        routeValues: {
                            project: project,
                            id: id
                        },
                        queryParams: queryValues
                    })];
            });
        });
    };

    // azure-devops-extension-api (at least until version 4.230.0) does not provide a wrapper for getting the comments versions.
    // So we define it ourselves. This corresponds to: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments-versions/list?view=azure-devops-rest-5.1
    WorkItemTrackingRestClient.prototype.getCommentsVersions_Patched = function (id, project, commentId) {
        // @ts-ignore
        return __awaiter(this, void 0, void 0, function () {
            var queryValues;
            // @ts-ignore
            return __generator(this, function (_a) {
                queryValues = {};
                return [2 /*return*/, this.beginRequest({
                        apiVersion: '5.1-preview.1',
                        routeTemplate: '{project}/_apis/wit/workItems/{id}/comments/{commentId}/versions',
                        routeValues: {
                            project: project,
                            id: id,
                            commentId: commentId
                        },
                        queryParams: queryValues
                    })];
            });
        });
    };

       
}


// Called when the user opens the new 'History' tab (not called when simply opening a work item, i.e. called
// lazily when actually required). Note that in queries the user can move up and down through the found items,
// and there this function gets called only once for every new work item type (bug, user story, task, etc.)
// encountered. For example, if there are two successive bugs, the user shows the history diff on the first bug,
// then moves on to the next bug, ADO will show immediately our history diff tab, but this function is not called
// again. Instead, the 'onUnloaded' and 'onLoaded' events are called (see CreateWorkItemPageEvents()).
async function InitializeHistoryDiff(adoSDK, adoAPI, workItemTracking, htmldiff)
{
    // Called by the ADO API after the client received and applied the theme. Also called when the user changes the theme
    // Doesn't seem to be documented.
    // https://github.com/microsoft/azure-devops-extension-sdk/blob/8dda1027b31c1fbe97ba4d92ee1bf541ed116061/src/SDK.ts#L495
    window.addEventListener('themeApplied', function (data) {
        DetectAndApplyDarkMode();
    });

    // Register the actual page shown by ADO.
    // Based on https://learn.microsoft.com/en-us/azure/devops/extend/develop/add-workitem-extension?view=azure-devops-2019#htmljavascript-sample
    // and https://learn.microsoft.com/en-us/azure/devops/extend/develop/add-workitem-extension?view=azure-devops-2019#add-a-page
    // Register function: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-sdk/#functions
    // Note: I couldn't get the adoSDK.ready() function to work; it was never called. Also, there are error messages if I do not call 
    // the adoSDK.register() function before init(). Moreover, in principle adoSDK.getContributionId() could be used to get the first
    // parameter for the register() function, but this does not work before init(). So I hardcoded the value.
    adoSDK.register('Sedenion.HistoryDiff.historydiff', function () {
            return CreateWorkItemPageEvents();
        });

    // https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-sdk/#azure-devops-extension-sdk-init
    // Options: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-sdk/iextensioninitoptions
    // We set 'loaded' to false, so that ADO shows the "spinning loading indicator" while we get all work item updates.
    adoSDK.init({applyTheme: true, loaded: false});

    gAdoSDK = adoSDK;
    gAdoAPI = adoAPI;
    gHtmlDiff = htmldiff;
    gWorkItemTracking = workItemTracking;
    gFieldTypeEnum = workItemTracking.FieldType;
    gWorkItemFormServiceId = workItemTracking.WorkItemTrackingServiceIds['WorkItemFormService'];
    
    PatchWorkItemTrackingRestClient(gWorkItemTracking.WorkItemTrackingRestClient);
    
    // getClient(): https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/#azure-devops-extension-api-getclient
    // Gives a WorkItemTrackingRestClient: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient
    gWorkItemRESTClient = gAdoAPI.getClient(gWorkItemTracking.WorkItemTrackingRestClient);

    // We first get the work item revisions from ADO, and only then tell ADO that we have loaded successfully.
    // This causes ADO to show the 'spinning loading indicator' until we are ready.
    await LoadAndSetDiffInHTMLDocument();

    adoSDK.notifyLoadSucceeded();
}

