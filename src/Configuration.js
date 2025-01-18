// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { CommonServiceIds } from 'azure-devops-extension-api/Common/CommonServices';
import { StringsMatchCaseInsensitiveWithWildcard } from './Utils.js';
import { LoadAndSetDiffInHTMLDocument } from './HistoryDiffPageScript.js';

const USER_CONFIG_KEY = "HistoryDiffUserConfig";

// IExtensionDataManager: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iextensiondatamanager
var gExtensionDataManager;


// The current version the extension uses. Every time we need to break backwards compatibility, we will
// increment it. That way we know when we read configs from an older version of the extension.
const USER_CONFIG_VERSION = 1;


// UserConfig constructor
function UserConfig(fieldFilters, fieldFiltersDisabled)
{
    // We store some version in the config so that we can better deal with future changes to the extension
    // that might make it necessary to brake backwards compatibility.
    this.configVersion = USER_CONFIG_VERSION;
    
    // string[] array. If an element matches a row name (i.e. field name), that corresponding field is 
    // omitted from the history. The intention is so that the user can hide uninteresting fields such
    // as working logging related fields.
    this.fieldFilters = fieldFilters;

    // Boolean. If true, the filters are disabled. The intention is that the user can temporarily disable
    // the filters without having to remove then (and then re-add them later).
    this.fieldFiltersDisabled = fieldFiltersDisabled;
}


const DEFAULT_USER_CONFIG = new UserConfig([], false);

var gUserConfig = DEFAULT_USER_CONFIG;


export async function LoadConfiguration(adoSDK)
{
    try {
        const extensionContext = adoSDK.getExtensionContext()
        
        const [accessToken, extensionDataService] = await Promise.all([
            adoSDK.getAccessToken(),
            adoSDK.getService(CommonServiceIds.ExtensionDataService)
        ]);
        
        // https://learn.microsoft.com/en-us/azure/devops/extend/develop/data-storage?view=azure-devops-2020
        // The data is stored on the server per user.
        gExtensionDataManager = await extensionDataService.getExtensionDataManager(extensionContext.id, accessToken);
        gUserConfig = await gExtensionDataManager.getValue(USER_CONFIG_KEY, {scopeType: "User", defaultValue: DEFAULT_USER_CONFIG});
    }
    catch (ex) {
        console.log(`HistoryDiff: Exception trying to load configuration: ${ex}`);
    }
}


function SaveFieldFiltersToConfig(newFieldFilters, fieldFiltersDisabled)
{
    try {
        gUserConfig = new UserConfig(newFieldFilters, fieldFiltersDisabled);
        gExtensionDataManager.setValue(USER_CONFIG_KEY, gUserConfig, {scopeType: "User"});
    }
    catch (ex) {
        console.log(`HistoryDiff: Exception trying to save configuration: ${ex}`);
    }
}


function AnyFieldFiltersEnabled()
{
    return gUserConfig && !gUserConfig.fieldFiltersDisabled && gUserConfig.fieldFilters && gUserConfig.fieldFilters.length >= 0;
}


export function IsFieldHiddenByUserConfig(rowName)
{
    if (!AnyFieldFiltersEnabled()) {
        return false;
    }
    return gUserConfig.fieldFilters.some(filteredField => StringsMatchCaseInsensitiveWithWildcard(rowName, filteredField));
}


function GetOpenFilterConfigButton()
{
    const button = document.getElementById("config-dialog-show");
    if (!button) {
        throw new Error('HistoryDiff: HTML element not found.');
    }
    return button;
}


function GetDisabledAllFieldFiltersCheckbox()
{
    const checkbox = document.getElementById("config-dialog-disable-all-field-filters");
    if (!checkbox) {
        throw new Error('HistoryDiff: HTML element not found.');
    }
    return checkbox;
}


function UpdateFilterButton()
{
    const numFilters = AnyFieldFiltersEnabled() ? gUserConfig.fieldFilters.length : 0;
    GetOpenFilterConfigButton().innerHTML = `<b>Filters (${numFilters} active)</b>`;
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

    const disabledFieldFiltersCheckbox = GetDisabledAllFieldFiltersCheckbox();

    GetOpenFilterConfigButton().addEventListener(
        "click", 
        () => {
            SetCurrentFieldFiltersInDialog(fieldFiltersTable);
            // @ts-ignore
            disabledFieldFiltersCheckbox.checked = gUserConfig?.fieldFiltersDisabled;
            // @ts-ignore
            configDialog.showModal();
    });

    UpdateFilterButton();

    document.getElementById("config-dialog-ok")?.addEventListener(
        "click", 
        () => {
            SaveAllFieldFiltersFromDialog(configDialog);
            UpdateFilterButton();
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

    // @ts-ignore
    const disabledAll = GetDisabledAllFieldFiltersCheckbox().checked;
    SaveFieldFiltersToConfig(filters, disabledAll);
}


function SetCurrentFieldFiltersInDialog(fieldFiltersTable)
{
    fieldFiltersTable.replaceChildren();
    if (gUserConfig?.fieldFilters) {
        for (const filter of gUserConfig.fieldFilters) {
            AddFieldFilterControlRowToDialog(fieldFiltersTable, filter);
        }
    }
}


function AddFieldFilterControlRowToDialog(fieldFiltersTable, filterString)
{
    const newInput = document.createElement("input");
    newInput.setAttribute("type", "text");
    newInput.setAttribute("list", "config-dialog-suggested-fields");
    newInput.setAttribute("size", "30");
    newInput.value = filterString;

    const newDeleteButton = document.createElement("button");
    newDeleteButton.setAttribute("class", "deleteFilter");
    newDeleteButton.textContent = "❌";
    
    const newRow = document.createElement("tr");
    newRow.appendChild(document.createElement("td")).appendChild(newInput);
    newRow.appendChild(document.createElement("td")).appendChild(newDeleteButton);
    
    fieldFiltersTable.appendChild(newRow);

    newDeleteButton.addEventListener("click", () => {
        fieldFiltersTable.removeChild(newRow);
    });
}
