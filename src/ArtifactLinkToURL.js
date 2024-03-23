// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { gLocationService } from './Globals';


export async function TryGetHTMLLinkNameAndUrlForArtifactLink(currentProjectName, artifactLink)
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

        // TODO: Links of type 'Integrated in release stage' (sometimes called 'Integrated in release stage').
        // They cannot be created manually, but are created by the system when a release pipeline with enabled 'Report deployment status to Work' 
        // is run (they are filtered out in the UI in _manualLinkingExclusionList()).
        // Example: vstfs:///ReleaseManagement/ReleaseEnvironment/2d63f741-0ba0-4bc6-b730-896745fab2c0:4:4
        //   => URL in the default ADO history: http://<Host>/<Collection>/<Project>/_release?releaseId=4&_a=release-summary
        // Problems/questions:
        // - How to parse the artifactId? '2d63f741-0ba0-4bc6-b730-896745fab2c0' is the project GUID, as in many other artifact links.
        //   But what is '4:4'? One of them is probably the 'releaseId', but the other one? Googling, they are not necessarily the same,
        //   e.g. https://stackoverflow.com/q/77282719. According to https://stackoverflow.com/q/62651418, the first one is the release ID
        //   while the second one is an 'environment ID' (whatever that means).
        //   So far I couldn't find the place in the ADO server installation source files where this particular vstfs string is built.
        // - How to create the URL? There are multiple possible routeId in the ADO server installation. Maybe 'release-progress-url-reroute'?
        //   But ADO itself seems to create the URL in ReleaseUrlUtils.getOldReleaseViewUrl(), not using a routeId? Moreover, there also seems 
        //   to be a 'New Releases Hub' preview feature (https://learn.microsoft.com/en-us/azure/devops/release-notes/2018/jun-19-vsts#organize-your-release-definitions-in-folders)
        //   (or is it enabled now by default)? Do we need to distinguish these two?

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
// Additionally, the split happens case-insensitive.
function SplitWithRemainder(str, separator, limit)
{
    if (limit === 0) {
        return [];
    }
    // 'i' for case-insensitive. https://stackoverflow.com/a/67227435
    const fullySplit = str.split(new RegExp(EscapeForRegex(separator), 'i'));
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


// Escapes some text so that it gets interpreted as normal text in a regex.
function EscapeForRegex(str)
{
    // https://stackoverflow.com/a/67227435
    return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
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

