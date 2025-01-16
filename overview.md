# History Diff <!-- omit in toc -->

The standard history tab of work items in Azure DevOps shows only the entire old and new values of each field, without highlighting the actual changes within it.
This makes spotting the difference very hard for fields that usually contain a lot of text; most prominently, the standard "Description" and "Repro Steps" fields as well as the comments.
This extension adds a **new tab** to work items that shows the full history of every field, while computing an **appropriate diff** for each one. Optionally, the user can filter out uninteresting fields (e.g. related to work logging).

**If you like the extension, please give it a [star on GitHub](https://github.com/Sedeniono/ADO-History-Diff) and rate on the [Visual Studio marketplace](https://marketplace.visualstudio.com/items?itemName=Sedenion.HistoryDiff)!**

The left image shows the default Azure DevOps history, while the right depicts the history as shown by the extension:
Changes to the text are much easier to spot.
![Example comparison](images/HistoryComparison.png)


**For installation instructions, documentation and source code, please head over to the [GitHub page](https://github.com/Sedeniono/ADO-History-Diff).**  
Release notes and alternative vsix-package downloads for each version can be found [on the release page of GitHub](https://github.com/Sedeniono/ADO-History-Diff/releases).
