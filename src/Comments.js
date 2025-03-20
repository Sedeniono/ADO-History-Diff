// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check


import { gWorkItemRESTClient } from './Globals';
import { DiffHtmlText, EscapeHtml } from './Utils';
import { CommentFormat } from 'azure-devops-extension-api/Comments';


// Artificial id used for comment updates.
export const COMMENT_UPDATE_ID = 'COMMENT';


/**
 * @returns {import('./HistoryDiffPageScript').UpdateTables[]}
 */
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

            const curTextHtml = GetHtmlFromComment(comment, curVersion);
            const prevTextHtml = GetHtmlFromComment(comment, prevVersion);
            const textChange = DiffHtmlText(prevTextHtml, curTextHtml);

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
            const tableRows = [{rowName: `Comment ${action}`, content: textChange}];

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
    let currentPage = await GetCommentsRESTRequest(
        workItemId, projectName, /*expand*/ 'renderedText', undefined, /*includeDeleted*/ true);
    if (!currentPage || !currentPage.comments || currentPage.comments.length == 0) {
        return [];
    }

    let allComments = currentPage.comments;

    while (currentPage.continuationToken) {
        currentPage = await GetCommentsRESTRequest(
            workItemId, projectName, /*expand*/ 'renderedText', undefined, 
            /*includeDeleted*/ true, undefined, currentPage.continuationToken);
        if (!currentPage || !currentPage.comments || currentPage.comments.length == 0) {
            break;
        }
        allComments.push.apply(allComments, currentPage.comments);
    }

    let commentsAwaiting = [];
    let versionsPromises = [];

    for (const comment of allComments) {
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

    return allComments;
}


// `comment` is a `Comment`: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments?view=azure-devops-rest-7.1&tabs=HTTP#comment
// `commentOrUpdate` is either a `Comment` or a `CommentVersion` (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments-versions/list?view=azure-devops-rest-7.1#commentversion)
// The `Comment` contains the `format` ("html" or "markdown"), while an `CommentVersion` does not contain the info.
function GetHtmlFromComment(comment, commentOrUpdate)
{
    if (!comment || !commentOrUpdate || commentOrUpdate.isDeleted) {
        return '';
    }

    // Currently, there are 2 possible formats in newer ADO versions: "html" and "markdown". The `renderedText` property of the 
    // comment always contains html. The `text` property contains either html or markdown, depending on the `format`. Older ADO
    // versions do not know the `format` property, in which case we always have html in both `text` and `renderedText`. But there
    // are weird things going on since at least ADO 2022:
    //
    // - If the format is "html":
    //   We could in principle return `renderedText`. But it turns out that at least ADO 2022 and Services return invalid URLs to
    //   images if the user directly pasted an image into a comment. On the other hand, the `text` property does contain the full
    //   valid HTML. For example:
    //     `text` contains:         <img src=\"https://dev.azure.com/<organisation>/<...>/_apis/wit/attachments/e3540083-6213-4003-9f90-6fe2e982c2f4?fileName=df532c25-76d5-413d-ade5-725d633ba2f5.png\" alt=Image>
    //     `renderedText` contains: <img src=\"ACK/e3540083-6213-4003-9f90-6fe2e982c2f4?fileName=df532c25-76d5-413d-ade5-725d633ba2f5.png\" alt=Image>
    //   Here, ACK in `renderedText` represents a single character, ASCII code 0x06. So for some reason, ADO replaces the base URL
    //   with ACK, but only in `renderedText`. According to https://developercommunity.visualstudio.com/t/Image-links-are-broken-for-comments-in-f/10579574,
    //   this happens due to some "sanitization", without any explanation what that is supposed to mean or why it is done.
    //   Also note that this ACK "sanitization" is only happening for the comments REST endpoint (GetCommentsRESTRequest()). The
    //   versions endpoint (GetCommentsVersionsRESTRequest()) returns identical `text` and `renderedText` values with correct URLs.
    //   => If the format is "html", we need to use the `text` property.
    //
    // - If the format is "markdown":
    //   We do not support diffing markdown yet. Instead we want to return the html, which is in `renderedText`. Fortunately,
    //   the html image URLs appear to be valid in the markdown case, for both GetCommentsRESTRequest() and 
    //   GetCommentsVersionsRESTRequest().
    //   Interestingly and as note for the future: `text` contains the markdown, but now with URLs "sanitized" with the ACK character,
    //   but only for GetCommentsVersionsRESTRequest(). `text` returned by GetCommentsRESTRequest() contains the full URL.
    //   => If the format is "markdown", we need to use the `renderedText` property.
    //
    // - If the comment used to be in html, and then was edited and converted to markdown by the user:
    //   The format is now "markdown". The `renderedText` in GetCommentsRESTRequest() contains html with valid URLs, while `text` 
    //   contains the markdown also with valid URLs.
    //   GetCommentsVersionsRESTRequest() for those versions that are in markdown: `text` contains markdown with ACK "sanitization",
    //   while `renderedText` contains html with correct URLs.
    //   GetCommentsVersionsRESTRequest() for those versions that were in html: `text` and `renderedText` contain html with correct URLs.
    //   Note: The CommentVersion (GetCommentsVersionsRESTRequest()) instances do NOT carry a `format` property, so it seems to be
    //   impossible to know for sure when a comment was switched from html to markdown by a user.
    //   => We use the `renderedText` property
    //
    // - If the comment used to be in markdown and then was edited and converted to html:
    //   Not possible currently. ADO does not allow converting markdown comments to html.
    // 
    //
    // To summarize, for future reference: 
    //   The ACK sanitization happens for URLs in the following properties:
    //     - format == html:     GetCommentsRESTRequest(),         `renderedText`
    //     - format == markdown: GetCommentsVersionsRESTRequest(), `text`
    //   Valid html with correct URLs are given by:
    //     - format == html: GetCommentsRESTRequest(),       `text`
    //                       GetCommentsVersionsRESTRequest, `text` and `renderedText`
    //     - format == markdown: GetCommentsRESTRequest(),         `renderedText`
    //                           GetCommentsVersionsRESTRequest(), `renderedText`    
    //   Valid markdown with correct URLs are given by:
    //     - format == html: Never
    //     - format == markdown: GetCommentsRESTRequest(), `text`
    //                           GetCommentsVersionsRESTRequest(): Never (`text` contains ACK)
    // 
    if (comment.format === undefined || comment.format === CommentFormat.Html) {
        // If `format` is undefined, we have an old ADO version, implying html. 
        // Moreover, the correct html is in `text`, not in `renderedText`. See above.
        return commentOrUpdate.text;
    }
    else if (commentOrUpdate.renderedText !== undefined) {
        // Probably a markdown comment, at least in the latest comment version (might have been html in earlier
        // versions of the comment, in which case `renderedText` is also fine; compare explanation above).
        return commentOrUpdate.renderedText;
    }
    else {
        // We shouldn't be able to reach this code here.
        return EscapeHtml(commentOrUpdate.text);
    }
}


// getComments() from the azure-devops-extension-api (at least until version 4.230.0) uses api-version=5.0-preview.2, which 
// doesn't allow to query deleted comments. But we need that. So we define a custom function that uses the newer REST API version 5.1.
// So our function corresponds to this REST request: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/get-comments?view=azure-devops-rest-5.1
async function GetCommentsRESTRequest(id, project, expand, top, includeDeleted, order, continuationToken)
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
            order: order,
            continuationToken: continuationToken
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
