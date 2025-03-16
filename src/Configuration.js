// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { CommonServiceIds } from 'azure-devops-extension-api/Common/CommonServices';
import { StringsMatchCaseInsensitiveWithWildcard, GetHtmlElement } from './Utils.js';
import { LoadAndSetDiffInHTMLDocument, ShowOrHideUnchangedLinesDependingOnConfiguration } from './HistoryDiffPageScript.js';

// @ts-ignore (webpack magic)
import DividerSplitDownSvg from '../images/divider-split-horizontal-icon-down.svg';
// @ts-ignore (webpack magic)
import DividerSplitUpSvg from '../images/divider-split-horizontal-icon-up.svg';
// @ts-ignore (webpack magic)
import SettingsSvg from '../images/setting-icon.svg';


const USER_CONFIG_KEY = 'HistoryDiffUserConfig_TmpTest';

// IExtensionDataManager: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iextensiondatamanager
var gExtensionDataManager;


// The current version the extension uses. Every time we need to break backwards compatibility, we will
// increment it. That way we know when we read configs from an older version of the extension.
const USER_CONFIG_VERSION = 3;


/**
 * UserConfig constructor
 * @param {string[]} fieldFilters
 * @param {boolean} fieldFiltersDisabled
 * @param {boolean} showUnchangedLines
 * @param {number} numContextLines
 */
function UserConfig(fieldFilters, fieldFiltersDisabled, showUnchangedLines, numContextLines)
{
    /** 
     * We store some version in the config so that we can better deal with future changes to the extension
     * that might make it necessary to brake backwards compatibility.
     * @type {Number} 
     */
    this.configVersion = USER_CONFIG_VERSION;
    
    /** 
     * If an element matches a row name (i.e. field name), that corresponding field is omitted from the history.
     * The intention is so that the user can hide uninteresting fields such as working logging related fields.
     * @type {string[]} 
     */
    this.fieldFilters = fieldFilters;

    /** 
     * If true, the filters are disabled. The intention is that the user can temporarily disable
     * the filters without having to remove then (and then re-add them later).
     * @type {boolean} 
     */
    this.fieldFiltersDisabled = fieldFiltersDisabled;

    /** 
     * If true, all lines are shown. If false, only a context window around an <ins> and <del> element is shown,
     * i.e. N lines below and above (where N = numContextLines).
     * @type {boolean} 
     */
    this.showUnchangedLines = showUnchangedLines;

    /** 
     * An integer >= 0. Specifies the number of lines below and above each <ins> and <del> element to show.
     * Only relevant if `showUnchangedLines` is true.
     * @type {Number} 
     */
    this.numContextLines = numContextLines;
}


// In earlier version of the HistoryDiff extension, we hid the "Rev" (=revision) and stack rank fields from users always.
// They clutter up the history quite a lot, and are probably uninteresting for many users. Hence we want to hide them by
// default. (We show these fields at all due to GitHub issues #2 and #3.)
const DEFAULT_USER_CONFIG = new UserConfig(['Rev', 'Stack Rank'], false, false, 3);

var gUserConfig = DEFAULT_USER_CONFIG;

var gInitConfigurationPromise;


export function InitializeConfiguration(adoSDK)
{
    // To improve loading times, we want to simultaneously fetch the configuration and the item's history.
    // Therefore, we do not "await" the promise here, but instead only once we really need to access the
    // config data.
    gInitConfigurationPromise = LoadAndInitializeConfiguration(adoSDK);
}


export async function IsFieldShownByUserConfig(rowName)
{
    await gInitConfigurationPromise;
    return IsFieldShownByUserConfigImpl(rowName);
}


function IsFieldShownByUserConfigImpl(rowName)
{
    if (!AnyFieldFiltersEnabled()) {
        return true;
    }
    return !gUserConfig.fieldFilters.some(filteredField => StringsMatchCaseInsensitiveWithWildcard(rowName, filteredField));
}


export async function UpdateConfigDialogFieldSuggestions(fields)
{
    await gInitConfigurationPromise;

    const datalist = GetHtmlElement('config-dialog-suggested-fields');
    datalist.replaceChildren();
    for (const field of fields) {
        if (IsFieldShownByUserConfigImpl(field)) { // Don't suggest already hidden fields.
            const newOption = document.createElement('option');
            newOption.value = field;
            datalist.appendChild(newOption);
        }
    }
}


export async function GetUserConfig()
{
    await gInitConfigurationPromise;
    return gUserConfig;
}


async function LoadAndInitializeConfiguration(adoSDK)
{
    await LoadConfiguration(adoSDK);
    InitializeConfigDialog();
}


async function LoadConfiguration(adoSDK)
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
        gUserConfig = await gExtensionDataManager.getValue(USER_CONFIG_KEY, {scopeType: 'User', defaultValue: DEFAULT_USER_CONFIG});
        if (!gUserConfig) {
            gUserConfig = DEFAULT_USER_CONFIG;
        }
        else if (gUserConfig.configVersion <= 1) {
            // For configs from earlier versions of the extension, add the "Rev" and stack rank fields, since we now
            // no longer hide these fields always. Also compare explanation at DEFAULT_USER_CONFIG.
            if (!gUserConfig.fieldFilters) {
                gUserConfig.fieldFilters = []
            }
            if (gUserConfig.fieldFilters.indexOf('Rev') < 0) {
                gUserConfig.fieldFilters.push('Rev');
            }
            if (gUserConfig.fieldFilters.indexOf('Stack Rank') < 0) {
                gUserConfig.fieldFilters.push('Stack Rank');
            }
        }
        else if (gUserConfig.configVersion <= 2) {
            gUserConfig.showUnchangedLines = DEFAULT_USER_CONFIG.showUnchangedLines;
            gUserConfig.numContextLines = DEFAULT_USER_CONFIG.numContextLines;
        }

        gUserConfig.numContextLines = SanitizeNumberOfContextLinesInput(gUserConfig.numContextLines);
        gUserConfig.configVersion = USER_CONFIG_VERSION;
    }
    catch (ex) {
        console.log(`HistoryDiff: Exception trying to load configuration: ${ex}`);
    }
}


function SaveNewUserConfig(userConfig)
{
    try {
        gUserConfig = userConfig;
        gUserConfig.numContextLines = SanitizeNumberOfContextLinesInput(gUserConfig.numContextLines);
        gExtensionDataManager.setValue(USER_CONFIG_KEY, gUserConfig, {scopeType: 'User'});
    }
    catch (ex) {
        console.log(`HistoryDiff: Exception trying to save configuration: ${ex}`);
    }
}


function AnyFieldFiltersEnabled()
{
    return gUserConfig && !gUserConfig.fieldFiltersDisabled && gUserConfig.fieldFilters && gUserConfig.fieldFilters.length >= 0;
}


function GetOpenConfigButton()
{
    return GetHtmlElement('config-dialog-show');
}

function GetToggleContextButton()
{
    return GetHtmlElement('toggle-context');
}

function GetDisabledAllFieldFiltersCheckbox()
{
    return GetHtmlElement('config-dialog-disable-all-field-filters');
}

function GetShowUnchangedLinesCheckbox()
{
    return GetHtmlElement('config-dialog-show-unchanged-lines');
}

function GetNumContextLinesControl()
{
    return GetHtmlElement('config-dialog-num-context-lines');
}


function UpdateOpenConfigButtonWithNumFilters()
{
    const img = document.createElement('img');
    img.src = SettingsSvg;
    img.style.height = '18px';
    img.style.marginRight = '5px';
        
    const numFilters = AnyFieldFiltersEnabled() ? gUserConfig.fieldFilters.length : 0;
    const textNode = document.createTextNode(
        numFilters === 1 ? `(${numFilters} filter)` : `(${numFilters} filters)`);

    const openConfigButton = GetOpenConfigButton();
    openConfigButton.textContent = '';
    openConfigButton.append(img, textNode);
}


function InitializeConfigDialog()
{
    UpdateOpenConfigButtonWithNumFilters();
    InitializeToggleContextButton();

    const configDialog = GetHtmlElement('config-dialog');
    const fieldFiltersTable = GetHtmlElement('config-dialog-field-filters-table');
    const disabledFieldFiltersCheckbox = GetDisabledAllFieldFiltersCheckbox();
    
    GetOpenConfigButton().addEventListener(
        'click', 
        () => {
            SetCurrentFieldFiltersInDialog(fieldFiltersTable);
            // @ts-ignore
            disabledFieldFiltersCheckbox.checked = gUserConfig?.fieldFiltersDisabled;
            // @ts-ignore
            GetShowUnchangedLinesCheckbox().checked = gUserConfig?.showUnchangedLines;
            // @ts-ignore
            GetNumContextLinesControl().value = gUserConfig?.numContextLines;
            // @ts-ignore
            configDialog.showModal();
    });

    GetHtmlElement('config-dialog-ok').addEventListener(
        'click', 
        () => {
            SaveNewUserConfigFromDialog(configDialog);
            UpdateOpenConfigButtonWithNumFilters();
            UpdateToggleContextButton();
            // @ts-ignore
            configDialog.close();
            LoadAndSetDiffInHTMLDocument();
    });

    GetHtmlElement('config-dialog-cancel').addEventListener(
        // @ts-ignore
        'click', () => configDialog.close());

    GetHtmlElement('config-dialog-add-field-filter').addEventListener(
        'click', () => AddFieldFilterControlRowToDialog(fieldFiltersTable, ''));
}


function SaveNewUserConfigFromDialog(configDialog)
{
    const allInputs = configDialog.getElementsByTagName('input');
    let filters = [];
    for (const inputCtrl of allInputs) {
        if (inputCtrl.type === 'text' && inputCtrl.value != null && inputCtrl.value.trim().length !== 0) {
            filters.push(inputCtrl.value);
        }
    }

    SaveNewUserConfig(new UserConfig(
        filters, 
        // @ts-ignore
        GetDisabledAllFieldFiltersCheckbox().checked,
        // @ts-ignore
        GetShowUnchangedLinesCheckbox().checked,
        // @ts-ignore
        SanitizeNumberOfContextLinesInput(GetNumContextLinesControl().value)
    ));
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
    const newInput = document.createElement('input');
    newInput.setAttribute('type', 'text');
    newInput.setAttribute('list', 'config-dialog-suggested-fields');
    newInput.setAttribute('size', '30');
    newInput.value = filterString;

    const newDeleteButton = document.createElement('button');
    newDeleteButton.setAttribute('class', 'delete-filter');
    newDeleteButton.textContent = '❌';
    
    const newRow = document.createElement('tr');
    newRow.appendChild(document.createElement('td')).appendChild(newInput);
    newRow.appendChild(document.createElement('td')).appendChild(newDeleteButton);
    
    fieldFiltersTable.appendChild(newRow);

    newDeleteButton.addEventListener('click', () => {
        fieldFiltersTable.removeChild(newRow);
    });
}


function UpdateToggleContextButton()
{
    const toggleButton = GetToggleContextButton();
    toggleButton.textContent = '';
    toggleButton.style.backgroundPosition = 'top 4px left 50%, bottom 4px left 50%';
    if (gUserConfig?.showUnchangedLines) {
        toggleButton.style.backgroundImage = `url(${DividerSplitDownSvg}), url(${DividerSplitUpSvg})`;
        toggleButton.title = 'Hide unchanged lines.';
    }
    else {
        toggleButton.style.backgroundImage = `url(${DividerSplitUpSvg}), url(${DividerSplitDownSvg})`;
        toggleButton.title = 'Show all unchanged lines.';
    }
}


function InitializeToggleContextButton()
{
    GetToggleContextButton().addEventListener(
        'click', 
        () => {
            gUserConfig.showUnchangedLines = !gUserConfig.showUnchangedLines;
            SaveNewUserConfig(gUserConfig);
            UpdateToggleContextButton();
            ShowOrHideUnchangedLinesDependingOnConfiguration();
    });

    UpdateToggleContextButton();
}


function SanitizeNumberOfContextLinesInput(value)
{
    if (!value) {
        return 0;
    }
    if (Number.isInteger(value)) {
        return value;
    }
    const asInt = parseInt(value);
    if (isNaN(asInt) || asInt < 0) {
        return 0;
    }
    return asInt;
}
