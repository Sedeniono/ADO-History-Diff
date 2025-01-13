// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { CommonServiceIds } from 'azure-devops-extension-api/Common/CommonServices';
import { StringsMatchCaseInsensitiveWithWildcard } from './Utils.js';
import { LoadAndSetDiffInHTMLDocument } from './HistoryDiffPageScript.js';

const FIELD_FILTERS_CONFIG = "FieldFiltersTest"; // TODO: Remove "Test"

// IExtensionDataManager: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iextensiondatamanager
var gExtensionDataManager;

// string[] array. If an element matches a row name (i.e. field name), that corresponding field is 
// omitted from the history. The intention is so that the user can hide uninteresting fields such
// as working logging related fields.
var gFieldFilters;


export async function LoadConfiguration(adoSDK)
{
    const extensionContext = adoSDK.getExtensionContext()
    
    const [accessToken, extensionDataService] = await Promise.all([
        adoSDK.getAccessToken(),
        adoSDK.getService(CommonServiceIds.ExtensionDataService)
    ]);
    
    // https://learn.microsoft.com/en-us/azure/devops/extend/develop/data-storage?view=azure-devops-2020
    // The data is stored on the server per user.
    gExtensionDataManager = await extensionDataService.getExtensionDataManager(extensionContext.id, accessToken);
    gFieldFilters = await gExtensionDataManager.getValue(FIELD_FILTERS_CONFIG, {scopeType: "User", defaultValue: ""});
}


export async function SaveFieldFiltersToConfig(newFieldFilters)
{
    gFieldFilters = newFieldFilters;
    gExtensionDataManager.setValue(FIELD_FILTERS_CONFIG, newFieldFilters, {scopeType: "User"})
}


export function IsFieldHiddenByUserConfig(rowName)
{
    if (!gFieldFilters || gFieldFilters.length === 0) {
        return false;
    }
    return gFieldFilters.some(filteredField => StringsMatchCaseInsensitiveWithWildcard(rowName, filteredField));
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

    document.getElementById("config-dialog-show")?.addEventListener(
        "click", 
        () => {
            SetCurrentFieldFiltersInDialog(fieldFiltersTable);
            // @ts-ignore
            configDialog.showModal();
    });

    document.getElementById("config-dialog-ok")?.addEventListener(
        "click", 
        () => {
            SaveAllFieldFiltersFromDialog(configDialog);
            // @ts-ignore
            configDialog.close();
            LoadAndSetDiffInHTMLDocument();
    });

    document.getElementById("config-dialog-cancel")?.addEventListener(
        // @ts-ignore
        "click", () => configDialog.close());

    document.getElementById("config-dialog-add-field-filter")?.addEventListener(
        "click", () => AddFieldFilterControlRowToDialog(fieldFiltersTable, ""));
}


export function UpdateConfigDialogFieldSuggestions(fields)
{
    const datalist = document.getElementById("config-dialog-suggested-fields");
    if (!datalist) { 
        throw new Error('HistoryDiff: HTML element not found.');
    }
    datalist.replaceChildren();
    for (const field of fields) {
        if (!IsFieldHiddenByUserConfig(field)) { // Don't suggest already hidden fields.
            const newOption = document.createElement("option");
            newOption.value = field;
            datalist.appendChild(newOption);
        }
    }
}


function SaveAllFieldFiltersFromDialog(configDialog)
{
    const allInputs = configDialog.getElementsByTagName("input");
    let filters = [];
    for (const inputCtrl of allInputs) {
        if (inputCtrl.type === "text" && inputCtrl.value != null && inputCtrl.value.trim().length !== 0) {
            filters.push(inputCtrl.value);
        }
    }
    SaveFieldFiltersToConfig(filters);
}


function SetCurrentFieldFiltersInDialog(fieldFiltersTable)
{
    fieldFiltersTable.replaceChildren();
    if (gFieldFilters) {
        for (const filter of gFieldFilters) {
            AddFieldFilterControlRowToDialog(fieldFiltersTable, filter);
        }
    }
}


function AddFieldFilterControlRowToDialog(fieldFiltersTable, filterString)
{
    const newInput = document.createElement("input");
    newInput.setAttribute("type", "text");
    newInput.setAttribute("list", "config-dialog-suggested-fields");
    newInput.value = filterString;

    const newDeleteButton = document.createElement("button");
    newDeleteButton.setAttribute("style", "user-select: none");
    newDeleteButton.textContent = "❌";
    
    const newRow = document.createElement("tr");
    newRow.appendChild(document.createElement("td")).appendChild(newInput);
    newRow.appendChild(document.createElement("td")).appendChild(newDeleteButton);
    
    fieldFiltersTable.appendChild(newRow);

    newDeleteButton.addEventListener("click", () => {
        fieldFiltersTable.removeChild(newRow);
    });
}
