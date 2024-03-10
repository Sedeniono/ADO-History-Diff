// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

var gAdoSDK;
var gAdoAPI;
var gHtmlDiff;
var gWorkItemFormServiceId;
var gWorkItemTracking;

// WorkItemTrackingRestClient: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient
var gWorkItemRESTClient;

// ILocationService: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/ilocationservice
var gLocationService;

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


async function GetTableInfosForEachRevisionUpdate(revisionUpdates, fieldsPropertiesMap, currentProjectName) 
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


async function TryGetHTMLLinkNameAndUrlForArtifactLink(currentProjectName, artifactLink)
{
    // Converting the artifact link to an actually usable url that the user can click is quite troublesome, because
    // the whole thing is almost entirely undocumented.
    //
    // The artifact link has the (undocumented) format:
    //      vstfs:///{artifactTool}/{artifactType}/{artifactId}
    // Also see https://developercommunity.visualstudio.com/t/artifact-uri-format-in-external-link-of-work-items/964448
    // or https://stackoverflow.com/a/65623491.
    // There is no official API to extract the 3 components. Furthermore, the artifactId can consist of 'sub-components'
    // that are usually separated by '%2F' (which is just the character '/' encoded).
    // The meaning of each component and sub-component is undocumented.
    // For completeness/documentation purposes: The standard ADO history splits the vstfs link (but no the artifactId) in 
    // a function called decodeUri(), which is called from
    // LinkMapper.mapLink() -> LinkMapper._mapExternalLink() -> createGitHubArtifactFromExternalLink() -> decodeUri()
    // (despite the 'GitHub', this seems to be called also for non-GitHub artifact links).
    //
    // Examples:
    //  - Repo link: vstfs:///Git/Ref/2d63f741-0ba0-4bc6-b730-896745fab2c0%2Fc0d1232d-66e9-4d5e-b5a0-50366bc67991%2FGBmain
    //  - Commit link: vstfs:///Git/Commit/2d63f741-0ba0-4bc6-b730-896745fab2c0%2Fc0d1232d-66e9-4d5e-b5a0-50366bc67991%2F2054d8fcd16469d4398b2c73d9da828aaed98e41
    //  - Build link: vstfs:///Build/Build/1
    //  - Wiki page: vstfs:///Wiki/WikiPage/2d63f741-0ba0-4bc6-b730-896745fab2c0%2F201005d4-3f97-4766-9b82-b69c89972e64%2FFirst%20wiki%20page
    //
    //
    // After having split the artifact link, I guess the intended way to retrieve a usable URL from its components is to use the 
    // official API ILocationService.routeUrl():
    // https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/ilocationservice#azure-devops-extension-api-ilocationservice-routeurl
    // At least this function does exactly what we want: It returns a usable URL, assuming that correct parameters were provided. 
    // Hence my guess that this is the intended way. However, allowed values for its parameters are not documented anywhere.
    // From my understanding:
    //   - The first parameter 'routeId' is some magic string/identifier that indicates the type of the URL to construct, i.e. it identifies
    //     the route template to use. A route template is a string containing parameters in curly braces. Examples:
    //        {project}/_git/{vc.GitRepositoryName}/commit/{parameters}
    //        {project}/_wiki/wikis/{*wikiIdentifier}
    //     To be more precise, a single 'routeId' is associated with multiple route templates. ADO apparently figures out which concrete
    //     route template to use from the given 'routeValues'. I guess this is the mechanism of getBestRouteMatch():
    //     https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/#azure-devops-extension-api-getbestroutematch
    //     (roughly, the highest number of replacements wins).
    //     An asterisk '*' in the route template is a so-called 'WildCardParam'. As far as I could tell from the ADO server installation
    //     source files, the only difference is that routeUrl() runs the strings through encodeURIComponent() if '*' is missing from the 
    //     route template parameter, and through encodeURI() if '*' is present. The only reference to this I could find in the documentation
    //     is the statement: If the route template terminates in a wildcard, such as /api/{*restOfPath}, the value {restOfPath} is a string 
    //     representation of the remaining path segments from the incoming request (https://learn.microsoft.com/en-us/azure/azure-functions/legacy-proxies#route-template-parameters).
    //   - The second parameter 'routeValues' is an object, where the fields correspond to placeholders in the route template.
    //
    // Possible values for the 'routeId' and 'routeValues' can be found by searching through the source files in the Azure DevOps Server
    // installation directory, especially in the 'extension.vsomanifest' and ms.vss-code-web\common-content\Navigation.js files.
    // The routeUrl() function, upon its first call, issues a REST request to get the route template strings associated with the 'routeId'.
    // Subsequent calls then use the cached route template.
    //
    // For documentation purposes: The default ADO history constructs the usable URL in TfsContext.getPublicActionUrl() and 
    // TfsContext.getActionUrl().
    //
    //
    // As an alternative to routeUrl(), we could also construct the URL ourselves. This would have the advantage of not requiring the
    // undocumented values for 'routeId' and 'routeValues', and also would bypass the additional REST requests.
    // But there are several disadvantages or other problems:
    //   - The format of the URL is not really documented. With this I mean for example that the wiki page path format
    //     '<Host>/<collectionOrOrganization>/<project>/_wiki/wikis/<wikiName>/<wikiPageId>/<wikiPageName>' is not documented.
    //     In fact, the URL that routeUrl() constructs has a different format (which forwards to the actual site, for whatever reason).
    //     I can also imagine that the URL format could change in the future.
    //   - We also would need to find out the host name ourselves. This is actually not that straightforward: We run in an iframe, and the 
    //     behavior is different in ADO Server (on-premise) and ADO Services. Even worse, ADO services changed the primary URL from 
    //     '<org name>.visualStudio.com' to 'devops.azure.com/<org name>' in the past, but admins can still select which one to use in the 
    //     ADO services settings. The documentation also states that the organization URL might change in the future again.
    //     Compare https://learn.microsoft.com/en-us/azure/devops/extend/develop/work-with-urls.
    //   - We also would need to get the collection (ADO Server) or organization (ADO Services) in the URL ourselves. 
    //   - To this end, note that gAdoSDK does provide some interfaces to get the data. But in my tests, they were cumbersome to use (only 
    //     available in the gAdoSDK.ready() promise) or broken (not even available in the gAdoSDK.ready() function, although I think they 
    //     should be, or did not have the documented fields). We would likely need to issue some REST requests manually to get the data.
    // Also, routeUrl() does seem like the intended way to construct the URL (except that Microsoft has forgotten to document it properly). 
    // => Therefore, using routeUrl() seems like the lesser evil.

    if (typeof artifactLink !== 'string') {
        return undefined;
    }

    const matches = artifactLink.match(/vstfs:\/\/\/(.*)\/(.*)\/(.*)/);
    if (matches?.length !== 4) {
        return undefined;
    }

    // TODO:
    // - Retrieve information from the linked artifacts?
    //   - Project and repository names for better display? I.e. in the history, show the project and repository names?
    //   - Build information (succeeded, failed, deleted)?
    //   - Information about tests?
    // - Show small icons, as in the default ADO history?
    // - Optimization: Maybe call routeUrl() at the start of the initialization to trigger the REST request as early as possible?
    // - https://learn.microsoft.com/en-us/azure/devops/boards/queries/link-type-reference?view=azure-devops#external-link-type
    //   Go through it. Maybe some links are created automatically, but cannot be created by the user.
    //   (_manualLinkingExclusionList?)

    const [, artifactTool, artifactType, artifactId] = matches;

    try {
        // TODO: GitHub links are not yet supported. We simply return undefined for them.
        // Examples:
        //   Link to GitHub commit a39edac1f528525bcde5fe2900ff50e9c941a879: vstfs:///GitHub/Commit/3b807e19-64cc-40ec-a036-a048c812d0f1%2Fa39edac1f528525bcde5fe2900ff50e9c941a879
        //   Link to GitHub pullrequest 2: vstfs:///GitHub/PullRequest/3b807e19-64cc-40ec-a036-a048c812d0f1%2F2
        //   Link to GitHub issue 1, manually created: vstfs:///GitHub/Issue/3b807e19-64cc-40ec-a036-a048c812d0f1%2F1
        //   Link to GitHub issue 3, created by Azure Board bot on GitHub (note '%2f' instead of '%2F' as separator): vstfs:///GitHub/Issue/3b807e19-64cc-40ec-a036-a048c812d0f1%2f3
        // In these examples, the '3b807e19-64cc-40ec-a036-a048c812d0f1' is some ID identifying the GitHub repository.
        // Unfortunately, there is no public REST API available to convert the vstfs links to usable URLs. At least for ADO Services,
        // the private API is 'https://dev.azure.com/<organization>/_apis/Contribution/HierarchyQuery/project/<projectGUID>' using POST,
        // where the payload contains 'contributionIds : ["ms.vss-work-web.github-link-data-provider"]'.
        // So, to support GitHub links properly, we would need to use that undocumented API. But Microsoft might change it at any time...
        // Also I haven't checked whether that private endpoint is the same for ADO Server 2019, 2020 and 2022.

        const parsers = {
            Git: {
                Commit: ParseArtifactLinkGitCommit,
                Ref: ParseArtifactLinkGitRef,
                PullRequestId: ParseArtifactLinkGitPullRequest
            },
            // TFVC (Team Foundation Version Control) links
            VersionControl: {
                Changeset: ParseArtifactLinkVersionControlChangeset,
                VersionedItem: ParseArtifactLinkVersionControlVersionedItem
            },
            Build: {
                Build: ParseArtifactLinkBuildBuild
            },
            Wiki: {
                WikiPage: ParseArtifactLinkWikiWikiPage
            },
            Requirements: {
                Storyboard: ParseArtifactRequirementsStoryboard
            },
            TestManagement: {
                TcmResult: ParseArtifactTestManagementTcmResult,
                TcmResultAttachment: ParseArtifactTestManagementTcmResultAttachment,
                TcmTest: ParseArtifactTestManagementTcmTest
            }
        };

        return parsers[artifactTool]?.[artifactType]?.(artifactLink, artifactId, currentProjectName);
    }
    catch (ex) {
        console.log(`HistoryDiff: Exception while parsing artifact link '${artifactLink}': ${ex}`);
        // Will show the raw link text.
        return undefined;
    }
}


// We need to split the artifactId from a vstfs link into its components, so that we can supply them to the 'routeValues'
// parameter of ILocationService.routeUrl(). There are two important traps here:
// - An artifactId of a certain artifact tool and type has a certain number of components that are separated by '%2F',
//   which is an encoded '/'. For example, the artifactId might consist of 3 components. Now, the string making up the
//   final component might come from a name (e.g. a git branch) that by itself contained a '/', which got encoded with
//   '%2F'. => We must split given artifactId only 'numComponents' times, and need to ensure, that the last component
//   retains all occurrences of '%2F'.
//   I think '/' cannot occur in the components except the last one. Parsing the artifactId would be ambiguous.
// - Special characters such as '!' are encoded in the components of artifactId. For example, '!' as '%20'. We will
//   pass the components in some form to ILocationService.routeUrl(), which itself runs it through the encoding process
//   again. So if we give it '!' as '%20' we end up with '%2520', because routeUrl() encoded the '%', resulting in an
//   invalid URL. => We must decode every component, so that routeUrl() can encode them again.
function SplitArtifactIdForRouteUrl(artifactId, numComponents)
{
    let components = SplitWithRemainder(artifactId, '%2F', numComponents);
    if (!components || components.length === 0) {
        return components;
    }
    return components.map(decodeURIComponent);
}


// Like the standard String.split() function, it returns an array with at most 'limit' elements.
// But if the given 'str' contains more separators that specified by 'limit', the last array element
// contains all the remaining string without being split.
function SplitWithRemainder(str, separator, limit)
{
    if (limit === 0) {
        return [];
    }
    const fullySplit = str.split(separator);
    if (!limit) {
        return fullySplit;
    }
    
    const lastElemsJoined = fullySplit.slice(limit - 1).join(separator);
    let result = fullySplit.slice(0, limit - 1);
    if (limit <= fullySplit.length) {        
        result.push(lastElemsJoined);
    }
    return result;
}


async function ParseArtifactLinkGitCommit(artifactLink, artifactId, currentProjectName)
{
    // Example: vstfs:///Git/Commit/2d63f741-0ba0-4bc6-b730-896745fab2c0%2Fc0d1232d-66e9-4d5e-b5a0-50366bc67991%2F2054d8fcd16469d4398b2c73d9da828aaed98e41
    //   => URL in the default ADO history: http://<Host>/<Collection>/<Project>/_git/c0d1232d-66e9-4d5e-b5a0-50366bc67991/commit/2054d8fcd16469d4398b2c73d9da828aaed98e41
    const details = SplitArtifactIdForRouteUrl(artifactId, 3);
    if (details.length !== 3) {
        return undefined;
    }

    // Compare 'VersionControl/Scripts/CommitArtifact.js' and 'wit-linked-work-dropdown-content\Util\Artifact.js' in the ADO Server installation.
    const [projectGuid, repositoryId, commitId] = details;

    /*
        "routeTemplates": [
            "{project}/{team}/_git/{vc.GitRepositoryName}/commit/{parameters}/{reviewMode}",
            "{project}/{team}/_git/{vc.GitRepositoryName}/commit/{parameters}",
            "{project}/_git/{vc.GitRepositoryName}/commit/{parameters}/{reviewMode}",
            "{project}/_git/{vc.GitRepositoryName}/commit/{parameters}",
            "_git/{project}/commit/{parameters}/{reviewMode}",
            "_git/{project}/commit/{parameters}"
        ],
    */
    const url = await gLocationService.routeUrl(
        'ms.vss-code-web.commit-route',
        {
            project: projectGuid,
            'vc.GitRepositoryName': repositoryId,
            parameters: commitId
        });
    return [commitId, url, ''];
}


async function ParseArtifactLinkGitRef(artifactLink, artifactId, currentProjectName)
{
    // Example branch: vstfs:///Git/Ref/2d63f741-0ba0-4bc6-b730-896745fab2c0%2Fc0d1232d-66e9-4d5e-b5a0-50366bc67991%2FGBmain
    //    => URL in the default ADO history: http://<Host>/<Collection>/<Project>/_git/c0d1232d-66e9-4d5e-b5a0-50366bc67991?version=GBmain
    //       (we will use the project GUID instead of the project name)
    // Example tag: vstfs:///Git/Ref/2d63f741-0ba0-4bc6-b730-896745fab2c0%2Fc0d1232d-66e9-4d5e-b5a0-50366bc67991%2FGTSomeTagInRepo
    //    => URL in the default ADO history: http://<Host>/<Collection>/<Project>/_git/c0d1232d-66e9-4d5e-b5a0-50366bc67991?version=GTSomeTagInRepo
    //       (we will use the project GUID instead of the project name)
    // Example commit: vstfs:///Git/Ref/2d63f741-0ba0-4bc6-b730-896745fab2c0%2Fc0d1232d-66e9-4d5e-b5a0-50366bc67991%2FGC055a2cd8575bf236145656b4fc8559981cc690ba
    const details = SplitArtifactIdForRouteUrl(artifactId, 3);
    if (details.length !== 3) {
        return undefined;
    }

    // Compare 'wit-linked-work-dropdown-content\Util\Artifact.js', constructLinkToContentFromRouteId() in 'Search\Scenarios\Shared\Utils.js' 
    // and 'common-content\Utils\Ref.js' in the ADO Server installation.
    // Git branches are prefixed with 'GB', git tags with 'GT', and git commits with 'GC'.
    const [projectGuid, repositoryId, refNameWithPrefix] = details;
    let refType;
    if (refNameWithPrefix.indexOf('GB') === 0) {
        refType = 'Branch';
    }
    else if (refNameWithPrefix.indexOf('GT') === 0) {
        refType = 'Tag';
    }
    else if (refNameWithPrefix.indexOf('GC') === 0) {
        // The ADO source files show that 'GC' is possible. However, I don't think that this type can be created via the ADO UI.
        // The UI creates a vstfs:///Git/Commit/... url when linking to commits, not a vstfs:///Git/Ref/ url.
        // But it is possible via the REST API (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-server-rest-6.0&tabs=HTTP#add-a-link).
        // The URL we create below does work correctly for commits. However, the 'links' tab in ADO doesn't show such links. Weird. Maybe 
        // a leftover from earlier ADO versions?
        refType = 'Commit';
    }
    else {
        // Note: The REST API (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-server-rest-6.0&tabs=HTTP#add-a-link)
        // actually allows to create invalid links, e.g. vstfs:///Git/Ref/SomethingInvalid
        // However, the 'links' tab in ADO doesn't show them.
        return undefined;
    }

    const refName = refNameWithPrefix.substring(2);

    /*
        "routeTemplates": [
            "{project}/{team}/_git/{vc.GitRepositoryName}",
            "{project}/_git/{vc.GitRepositoryName}",
            "_git/{project}"
        ],
    */
    const url = await gLocationService.routeUrl(
        'ms.vss-code-web.files-route-git',
        {
            project: projectGuid,
            'vc.GitRepositoryName': repositoryId,
            // The branch/tag/commit name must be appended as '?version=refNameWithPrefix' to the URL.
            version: refNameWithPrefix
        });
    return [refName, url, refType];
}


async function ParseArtifactLinkGitPullRequest(artifactLink, artifactId, currentProjectName)
{
    // Example: vstfs:///Git/PullRequestId/2d63f741-0ba0-4bc6-b730-896745fab2c0%2Fc0d1232d-66e9-4d5e-b5a0-50366bc67991%2F2
    //   => URL in the default ADO history: http://<Host>/<Collection>/<Project>/_git/TestRepo/pullrequest/2?_a=overview
    const details = SplitArtifactIdForRouteUrl(artifactId, 3);
    if (details.length !== 3) {
        return undefined;
    }

    // See 'VersionControl\Scripts\PullRequestArtifact.js' in the ADO Server installation.
    const [projectGuid, repositoryId, pullRequestId] = details;

    /*
        "routeTemplates": [
            "{project}/{team}/_git/{vc.GitRepositoryName}/pullrequest/{parameters}",
            "{project}/_git/{vc.GitRepositoryName}/pullrequest/{parameters}",
            "_git/{project}/pullrequest/{parameters}"
        ],
    */
    const url = await gLocationService.routeUrl(
        'ms.vss-code-web.pull-request-review-route',
        {
            project: projectGuid,
            'vc.GitRepositoryName': repositoryId,
            parameters: pullRequestId
        });
    return [pullRequestId, url, ''];
}


async function ParseArtifactLinkVersionControlChangeset(artifactLink, artifactId, currentProjectName)
{
    // Example: vstfs:///VersionControl/Changeset/3
    //   => URL in the default ADO history: http://<Host>/<Collection>/TFVC%20Project/_versionControl/changeset/3
    const changesetID = artifactId;

    /*
        "routeTemplates": [
            "{project}/{team}/_versionControl/changeset/{parameters}/{reviewMode}",
            "{project}/{team}/_versionControl/changeset/{parameters}",
            "{project}/_versionControl/changeset/{parameters}/{reviewMode}",
            "{project}/_versionControl/changeset/{parameters}"
        ],
    */
    const url = await gLocationService.routeUrl(
        'ms.vss-code-web.changeset-route',
        {
            // The ADO UI of work items apparently does not allow to link to TFVC changesets in other projects.
            // However, when creating a changeset in another project, one is allowed to link it to a work item
            // in another project. Hence, ADO does know links to changesets in other projects. Problem: The
            // vstfs link does not contain the project containing the changeset. Changeset numbers seem, however,
            // to be unique across all projects/repos. So the project is in principle not necessary. The ADO server
            // source files even show that there is another routeId ('collection-changeset-route') and with a route 
            // template '_versionControl/changeset/{parameters}' without the project . However, the resulting URL is
            // invalid. So, to be precise, we would need to use some ADO API to query the project containing the given
            // changeset ID. But all of this seems quite troublesome and not worth the effort: First of all,
            // specifying an incorrect project here still results in a valid URL to the changeset (but ADO displays
            // the changeset then in the context of the given project). Second, who is still using TFVC? Third,
            // the few people who use TFVC will probably not use links to TFVC repos in other projects.
            // => Simply use the current work item's project.
            project: currentProjectName,
            parameters: changesetID
        });
    return [changesetID, url, ''];
}


async function ParseArtifactLinkVersionControlVersionedItem(artifactLink, artifactId, currentProjectName)
{
    // Example link to latest version: vstfs:///VersionControl/VersionedItem/%252524%25252FTFVC%252520Project%25252FSomeFile.txt%2526changesetVersion%253DT%2526deletionId%253D0
    // Example link to changeset 4: vstfs:///VersionControl/VersionedItem/%252524%25252FTFVC%252520Project%25252FSomeFile.txt%2526changesetVersion%253D4%2526deletionId%253D0
    // Example link to latest changeset, file in a folder, filename contains a '&': vstfs:///VersionControl/VersionedItem/%252524%25252FTFVC%252520Project%25252FSome%252520folder%25252FFile%252520%252526%252520And.txt%2526changesetVersion%253DT%2526deletionId%253D0
    //   => URL in the default ADO history: http://<Host>/<Collection>/TFVC%20Project/_versionControl?path=%24%2FTFVC%20Project%2FSome%20folder%2FFile%20%26%20And.txt&version=T&_a=contents
    
    // Example for file in a folder, and the filename contains a '&':
    //   artifactId: '%252524%25252FTFVC%252520Project%25252FSome%252520folder%25252FFile%252520%252526%252520And.txt%2526changesetVersion%253DT%2526deletionId%253D0'
    //   decodeURIComponent(artifactId): '%2524%252FTFVC%2520Project%252FSome%2520folder%252FFile%2520%2526%2520And.txt%26changesetVersion%3DT%26deletionId%3D0'
    //   decodeURIComponent(decodeURIComponent(artifactId)): '%24%2FTFVC%20Project%2FSome%20folder%2FFile%20%26%20And.txt&changesetVersion=T&deletionId=0'
    //   decodeURIComponent(decodeURIComponent(decodeURIComponent(artifactId))): '$/TFVC Project/Some folder/File & And.txt&changesetVersion=T&deletionId=0'
    // => Need to extract the 'changesetVersion' after the second decodeURIComponent().
    const twiceDecoded = decodeURIComponent(decodeURIComponent(artifactId));
    const encodedPathAndArgumentsSplit = twiceDecoded.split('&');
    
    const details = SplitArtifactIdForRouteUrl(encodedPathAndArgumentsSplit[0], 3);
    if (details.length !== 3) {
        return undefined;
    }

    const [dollar, projectName, filepath] = details;
    
    let changesetVersion;
    for (let idx = 1; idx < encodedPathAndArgumentsSplit.length; ++idx) {
        const startStr = 'changesetVersion=';
        if (encodedPathAndArgumentsSplit[idx].indexOf(startStr) === 0) {
            changesetVersion = encodedPathAndArgumentsSplit[idx].substring(startStr.length);
            break;
        }
    }

    /*
        "routeTemplates": [
            "{project}/{team}/_versionControl",
            "{project}/_versionControl"
        ],
    */
    const url = await gLocationService.routeUrl(
        'ms.vss-code-web.files-route-tfvc',
        {
            project: projectName,
            path: filepath,
            version: changesetVersion // Not in the routeTemplate, added as '?version='
        });

    // 'T' for 'tip'. Compare 'repos-common\Util\Version.js' in the ADO server installation.
    const readableChangeset = changesetVersion === 'T' ? 'Latest changeset' : `Changeset ${changesetVersion}`;
    return [filepath, url, readableChangeset];
}


async function ParseArtifactLinkBuildBuild(artifactLink, artifactId, currentProjectName)
{
    // Used for 'Build', 'Found in build' and 'Integrated in build' links.
    // Example: vstfs:///Build/Build/5
    //   => URL in the default ADO history: http://<Host>/<Collection>/2d63f741-0ba0-4bc6-b730-896745fab2c0/_build/results?buildId=5
    const buildId = artifactId;

    /*
        "routeTemplates": [
            "{project}/{team}/_build/results",
            "{project}/_build/results"
        ],
    */
    const url = await gLocationService.routeUrl(
        'ms.vss-build-web.ci-results-hub-route',
        {
            // TODO: The build can be in a different project. Using the current project in this case results
            // in a URL pointing to a non-existent build. The buildId is unique over all projects. So we would 
            // need to query the actual project of the build using some API.
            project: currentProjectName,
            buildId: buildId // Not in the routeTemplate, added as '?buildId='
        });
    
    return [buildId, url, ''];
}


async function ParseArtifactLinkWikiWikiPage(artifactLink, artifactId, currentProjectName)
{
    // Example link to page 'Difficult + Pa-ge/Difficult + SubPa-ge': 
    // vstfs:///Wiki/WikiPage/2d63f741-0ba0-4bc6-b730-896745fab2c0%2F201005d4-3f97-4766-9b82-b69c89972e64%2FDifficult%20%2B%20Pa-ge%2FDifficult%20%2B%20SubPa-ge
    //   => URL in the default ADO history: http://<Host>/<Collection>/<Project>/_wiki/wikis/201005d4-3f97-4766-9b82-b69c89972e64?pagePath=%2FDifficult+%2B+Pa%252Dge%2FDifficult+%2B+SubPa%252Dge
    const details = SplitArtifactIdForRouteUrl(artifactId, 3);
    if (details.length !== 3) {
        return undefined;
    }

    // See 'page-rename-panel-content\WikiPageArtifactHelper.js' in the ADO server installation.
    const [projectGuid, wikiId, wikiPagePath] = details;

    if (!wikiPagePath) {
        return undefined;
    }

    // The default ADO history does a few special things:
    // - A minus '-' needs to end up as '%252D' in the final URL for ADO to be able to parse the URL 
    //    => replace '-' with '%2D' before routeUrl().
    // - Moreover, the default ADO history always starts the page path with '/' (encoded as '%2F'). So we do this, too.
    // - The default ADO history also replaces a space ' ' with '+' instead of '%20' in the final encoded URL. However, we
    //   don't do this, because we would need to do it after routeUrl() (because a '+' needs to end up as '%2B'), and ADO 
    //   fortunately can also handle '%20' just fine (as it should, since '%20' should be a valid encoding for a space always; 
    //   see e.g. https://stackoverflow.com/a/2678602).
    // Also see normalizeWikiPagePath() in 'wiki-view-common-content\Utils\PathHelper.js' in the ADO server installation.
    let normalizedPath = wikiPagePath.replace(/-/g, '%2D');
    if (normalizedPath[0] != '/') {
        normalizedPath = '/' + normalizedPath;
    }

    /*
        "routeTemplates": [
            "{project}/{team}/_wiki/wikis/{wikiIdentifier}/{pageId}/{*friendlyName}",
            "{project}/{team}/_wiki/wikis/{*wikiIdentifier}",
            "{project}/_wiki/wikis/{wikiIdentifier}/{pageId}/{*friendlyName}",
            "{project}/_wiki/wikis/{*wikiIdentifier}",
            "{project}/{team}/_wiki",
            "{project}/_wiki"
        ],
    */
    let url = await gLocationService.routeUrl(
        'ms.vss-wiki-web.wiki-overview-nwp-route2',
        {
            project: projectGuid,
            wikiIdentifier: wikiId,
            pagePath: normalizedPath // Not in the routeTemplate, added as '?pagePath='
        });

    return [wikiPagePath, url, ''];
}


async function ParseArtifactRequirementsStoryboard(artifactLink, artifactId, currentProjectName)
{
    // According to the documentation (https://learn.microsoft.com/en-us/azure/devops/boards/queries/link-type-reference?view=azure-devops#external-link-type),
    // a storyboard link is just a normal hyperlink. Apparently it is intended especially to link to PowerPoint files:
    // https://learn.microsoft.com/en-us/previous-versions/azure/devops/boards/backlogs/office/storyboard-your-ideas-using-powerpoint?view=tfs-2017
    // But this has been deprecated in ADO >= 2019. The artifact type still exists, however, and it actually allows linking to any file.
    // Example: vstfs:///Requirements/Storyboard/https%3A%2F%2Ffile-examples.com%2Fwp-content%2Fstorage%2F2017%2F08%2Ffile_example_PPT_250kB.ppt
    //   => URL in the default ADO history: https://file-examples.com/wp-content/storage/2017/08/file_example_PPT_250kB.ppt
    const storyboardURL = decodeURIComponent(artifactId);
    return [decodeURI(storyboardURL), storyboardURL, ''];
}


async function ParseArtifactTestManagementTcmResult(artifactLink, artifactId, currentProjectName)
{
    // Example: vstfs:///TestManagement/TcmResult/5.100000
    //   => URL in the default ADO history: http://<Host>/<collection>//<Project>/_testManagement/runs/?_a=resultSummary&runId=5&resultId=100000
    // See addResultLinkToWorkItem() in 'TestManagement\Scripts\TFS.TestManagement.js' in the ADO Server installation.
    const details = artifactId.split('.');
    if (details.length !== 2) {
        return undefined;
    }
    const [testRunId, testResultId] = details;

    /*
        "routeTemplates": [
            "{project}/{team}/_testManagement/runs",
            "{project}/_testManagement/runs"
        ],
    */
    let url = await gLocationService.routeUrl(
        'ms.vss-test-web.test-runs-route',
        {
            project: currentProjectName, // TODO: Can the test be in a different project?
            '_a': 'resultSummary', // Not in the routeTemplate, added as '?_a='
            runId: testRunId, // Not in the routeTemplate, added as '?runId='
            resultId: testResultId // Not in the routeTemplate, added as '?resultId='
        });

    // TODO: Show the test name? But need to query another API...
    return [`Test run ${testRunId}, test result ${testResultId}`, url, ''];
}


async function ParseArtifactTestManagementTcmResultAttachment(artifactLink, artifactId, currentProjectName)
{
    // Example (linking to test attachment 'SomeFile (1).txt'): vstfs:///TestManagement/TcmResultAttachment/3.100000.3
    //   => URL in the default ADO history: http://<Host>/<collection>/2d63f741-0ba0-4bc6-b730-896745fab2c0/_api/_testManagement/downloadTcmAttachment?testResultAttachmentUri=vstfs%3A%2F%2F%2FTestManagement%2FTcmResultAttachment%2F3.100000.4
    // There does not seem to be a routeId or route template for result attachments. So we need to construct it ourselves.
    // We simply use 'ms.vss-test-web.test-runs-route' to get the basic part of the URL (especially host and collection/organization). 
    // This is basically a hack.
    // Resulting runsURL example: http://<Host>/<collection>/<Project>/_testManagement/runs
    // TODO: Can the test be in a different project?
    const runsURL = await gLocationService.routeUrl('ms.vss-test-web.test-runs-route', { project: currentProjectName });
    
    const runsSuffix = '/_testManagement/runs';
    if (runsURL.indexOf(runsSuffix) !== runsURL.length - runsSuffix.length) {
        return undefined;
    }

    const baseURL = runsURL.substring(0, runsURL.length - runsSuffix.length + 1);
    const fullURL = `${baseURL}_api/_testManagement/downloadTcmAttachment?testResultAttachmentUri=${encodeURIComponent(artifactLink)}`;

    // TODO: Show the file name? Probably not worth the effort, since ADO puts the filename into the link comment,
    // and we show the link comment right below the actual link.
    return [`Attachment ${artifactId}`, fullURL , ''];
}


async function ParseArtifactTestManagementTcmTest(artifactLink, artifactId, currentProjectName)
{
    // Example: vstfs:///TestManagement/TcmTest/1
    //   => URL in the default ADO history: http://<Host>/<collection>/<project>/_TestManagement/Runs?_a=contribution&runId=5&resultId=100000&selectedGroupBy=group-by-branch&contributionId=ms.vss-test-web.test-result-history
    // The artifactId (in the example, the '1') is named 'testCaseReferenceId' or 'testCaseRefId' in the ADO server installation source files.
    // The default ADO history shows mostly the same link as for 'TcmResult', except that it leads directly to the 'history' tab of the run.
    // Not really sure how we get from the '1' given for the 'TcmTest' to the 'runId=5&resultId=100000'... There seems to be some undocumented
    // API involved. 
    // For now, we simply display just the testcase reference id, without a hyperlink.
    // TODO: Improve this.
    return [`Testcase reference ID ${artifactId}`, '', ''];
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
    // Note for picklists: It seems that they are used only for user-added fields. They appear as combo boxes.
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

    return EscapeHtml(fieldsPropertiesMap?.[fieldReferenceName].name);
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

    const allUpdateTables = await GetFullUpdateTables(comments, revisionUpdates, fieldsPropertiesMap, projectName);
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
async function InitializeHistoryDiff(adoSDK, adoAPI, workItemTracking, adoCommonServices, htmldiff)
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
        
    adoSDK.ready().then(function() {
        // Register the actual page shown by ADO.
        // Based on https://learn.microsoft.com/en-us/azure/devops/extend/develop/add-workitem-extension?view=azure-devops-2019#htmljavascript-sample
        // and https://learn.microsoft.com/en-us/azure/devops/extend/develop/add-workitem-extension?view=azure-devops-2019#add-a-page
        // Register function: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-sdk/#functions
        adoSDK.register(adoSDK.getContributionId(), function () {
            return CreateWorkItemPageEvents();
        });
    });

    gAdoSDK = adoSDK;
    gAdoAPI = adoAPI;
    gHtmlDiff = htmldiff;
    gWorkItemTracking = workItemTracking;
    gFieldTypeEnum = workItemTracking.FieldType;
    gWorkItemFormServiceId = workItemTracking.WorkItemTrackingServiceIds.WorkItemFormService;

    gLocationService = await gAdoSDK.getService(adoCommonServices.CommonServiceIds.LocationService);
    
    // getClient(): https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/#azure-devops-extension-api-getclient
    // Gives a WorkItemTrackingRestClient: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient
    gWorkItemRESTClient = gAdoAPI.getClient(gWorkItemTracking.WorkItemTrackingRestClient);

    // We first get the work item revisions from ADO, and only then tell ADO that we have loaded successfully.
    // This causes ADO to show the 'spinning loading indicator' until we are ready.
    await LoadAndSetDiffInHTMLDocument();

    adoSDK.notifyLoadSucceeded();
}



require(['azure-devops-extension-sdk', 
         'azure-devops-extension-api', 
         'azure-devops-extension-api/WorkItemTracking',
         'azure-devops-extension-api/Common/CommonServices',
         'node-htmldiff'
        ], 
        // @ts-ignore
        function (adoSDK, adoAPI, workItemTracking, adoCommonServices, htmldiff) {
            InitializeHistoryDiff(adoSDK, adoAPI, workItemTracking, adoCommonServices, htmldiff);
        }
);
