// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { CommonServiceIds } from 'azure-devops-extension-api/Common/CommonServices';

const FIELD_FILTER_CONFIG = "FieldFilterTest";

// IExtensionDataManager: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iextensiondatamanager
var gExtensionDataManager;

var gFieldFilter;


export async function LoadConfiguration(adoSDK)
{
    const extensionContext = adoSDK.getExtensionContext()
    
    const [accessToken, extensionDataService] = await Promise.all([
        adoSDK.getAccessToken(),
        adoSDK.getService(CommonServiceIds.ExtensionDataService)
    ]);
    
    // https://learn.microsoft.com/en-us/azure/devops/extend/develop/data-storage?view=azure-devops-2020
    gExtensionDataManager = await extensionDataService.getExtensionDataManager(extensionContext.id, accessToken);
    gFieldFilter = await gExtensionDataManager.getValue(FIELD_FILTER_CONFIG, {scopeType: "User", defaultValue: ""});
}


export async function SaveFieldFilterToConfig(newFieldFilter)
{
    gFieldFilter = newFieldFilter;
    gExtensionDataManager.setValue(FIELD_FILTER_CONFIG, newFieldFilter, {scopeType: "User"})
}


export function GetFieldFilterConfig()
{
    return gFieldFilter;
}


export function InitializeConfigDialog()
{
    const configDialog = document.getElementById("config-dialog");
    if (!configDialog) {
        throw new Error('HistoryDiff: HTML element not found.');
    }

    const fieldFiltersTable = document.getElementById("config-dialog-field-filters-table");
    if (!fieldFiltersTable) {
        throw new Error('HistoryDiff: HTML element not found.');
    }

    document.getElementById("config-dialog-close")?.addEventListener(
        "click", 
        () => {
            // @ts-ignore
            configDialog.close();
            const allInputs = configDialog.getElementsByTagName("input");
            let concat = "";
            for (const input of allInputs) {
                if (input.type === "text") {
                    concat += input.value;
                }
            }
            // TODO Do something with concat
            console.log("TEST DIALOG: " + concat);
        });

    document.getElementById("config-dialog-show")?.addEventListener(
        // @ts-ignore
        "click", () => configDialog.showModal());

    document.getElementById("config-dialog-add-field-filter")?.addEventListener(
        "click", () => AddFieldFilterControlRowToDialog(fieldFiltersTable));
}


function AddFieldFilterControlRowToDialog(fieldFiltersTable)
{
    const newInput = document.createElement("input");
    newInput.setAttribute("type", "text");
    const newDeleteButton = document.createElement("button");
    newDeleteButton.setAttribute("style", "user-select: none");
    newDeleteButton.innerHTML = "❌";
    
    const newRow = document.createElement("tr");
    newRow.appendChild(document.createElement("td")).appendChild(newInput);
    newRow.appendChild(document.createElement("td")).appendChild(newDeleteButton);
    
    fieldFiltersTable.appendChild(newRow);

    newDeleteButton.addEventListener("click", () => {
        fieldFiltersTable.removeChild(newRow);
    });
}
