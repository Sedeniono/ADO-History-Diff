# Azure DevOps History Diff <!-- omit in toc -->


- [Introduction](#introduction)
- [Installation](#installation)
- [Details](#details)
- [Future ideas](#future-ideas)


# Introduction
The history tab of work items in Azure DevOps (ADO) shows only the old and new values of each field, without highlighting the actual changes within the field.
This makes spotting the difference very hard for fields that usually contain a lot of text; most prominently, the standard "Description" field.
This extension shows the full history of the work item of every field, while computing an appropriate diff for each one.

The left image shows the default ADO history, while the right depicts the history as shown by the extension:
Changes to the text are much clearer.
![Example comparison](images/HistoryComparison.png)


# Installation
Requirements:
* Azure DevOps:
  * On Premise: [Azure DevOps Server](https://azure.microsoft.com/en-us/products/devops/server) 2019, 2020 or 2022. (Tested with 2019.1.2, 2020.1.2 and 2022.1.)
  * Also supports the cloud variation [Azure DevOps Services](https://azure.microsoft.com/en-us/products/devops)
* Users should use a reasonably recent browser (year >2020). Tested with Edge, Chrome and Firefox.

Install the extension from the Microsoft marketplace.
Please see the official description for [Azure DevOps Services](https://learn.microsoft.com/en-us/azure/devops/marketplace/install-extension?view=azure-devops) and [Azure DevOps Server](https://learn.microsoft.com/en-us/azure/devops/marketplace/install-extension?view=azure-devops-2022).

If you want to inspect the contents/source code of the vsix package, it can be extracted using tools such as [7-zip](https://www.7-zip.org/).
If you want to build the vsix package yourself (also compare the [official Microsoft documentation](https://learn.microsoft.com/en-us/azure/devops/extend/get-started/node)):
* Download the source code.
* `npm install` to get the dependencies.
* `npx tfx-cli extension create` to create the vsix package.



# Details
The extension adds a new tab called "History" on the work item page.
It does **not** modify the existing ADO history page because this is not possible with an extension to the best of my knowledge.

When opening the new "History" tab, the extension gets all previous changes of the work item via the Azure DevOps REST API.
For HTML-based fields (e.g. the "Description" field, comments, or custom fields of type "Text (multiple lines)"), the extension uses [htmldiff](https://www.npmjs.com/package/node-htmldiff) to compute a diff that is aware of HTML elements.
String fields are diffed as ordinary strings (actually, using the same library, but with special characters escaped).
For all other fields types, computing a diff makes no sense and the old and new values are shown directly.

Removed/old fragments are highlighted with a red background, new fragments with a green background.
The extension is aware of the dark mode theme and uses different colors.
Note: Changing the theme in Azure DevOps (light to dark or vice versa) does not immediately change all colors. The page needs to be reloaded.


# Future ideas
* Show the history of comments. The [Javascript REST client libraries](https://www.npmjs.com/package/azure-devops-extension-api) do not expose the corresponding [REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments-versions/get), so the request has to be made manually.
* Fork and improve [htmldiff](https://www.npmjs.com/package/node-htmldiff) to highlight pure formatting changes.
* Once [markdown is available in Azure DevOps work items](https://developercommunity.visualstudio.com/t/add-markdown-support-in-discussions/365826), support it.
* Show only the context of a change in longer descriptions (optionally).
* Localization
* Instead of getting all changes of a work item, pages or an "infinite scrolling" mechanism would be nice. Getting all changes can be slow if the history is long.
* Minimize the distributed files.
* Support the test case steps field (`Microsoft.VSTS.TCM.Steps`).
