// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check


import { gWorkItemRESTClient } from './Globals';
import { DiffHtmlText } from './Utils';


// Artificial id used for comment updates.
export const COMMENT_UPDATE_ID = 'COMMENT';


export function GetTableInfosForEachComment(comments)
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
export async function GetCommentsWithHistory(workItemId, projectName)
{
    // Note: In contrast to getUpdates(), apparently the REST request is not paged. It returns always all comments by default.
    const allComments = await GetCommentsRESTRequest(
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
            const versionsPromise = GetCommentsVersionsRESTRequest(workItemId, projectName, comment.id);
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


// getComments() from the azure-devops-extension-api (at least until version 4.230.0) uses api-version=5.0-preview.2, which 
// doesn't allow to query deleted comments. But we need that. So we define a custom function that uses the newer REST API version 5.1.
// So our function corresponds to this REST request: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments?view=azure-devops-rest-5.1
async function GetCommentsRESTRequest(id, project, expand, top, includeDeleted, order)
{
    return gWorkItemRESTClient.beginRequest({
        apiVersion: '5.1-preview.3',
        routeTemplate: '{project}/_apis/wit/workItems/{id}/comments',
        routeValues: {
            project: project,
            id: id
        },
        queryParams: {
            '$expand': expand,
            '$top': top,
            includeDeleted: includeDeleted,
            order: order
        }
    });
}


// azure-devops-extension-api (at least until version 4.230.0) does not provide a wrapper for getting the comments versions.
// So we define it ourselves. This corresponds to: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments-versions/list?view=azure-devops-rest-5.1
async function GetCommentsVersionsRESTRequest(id, project, commentId)
{
    return gWorkItemRESTClient.beginRequest({
        apiVersion: '5.1-preview.1',
        routeTemplate: '{project}/_apis/wit/workItems/{id}/comments/{commentId}/versions',
        routeValues: {
            project: project,
            id: id,
            commentId: commentId
        },
        queryParams: {}
    });
}
