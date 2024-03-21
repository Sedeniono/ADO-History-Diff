// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { gHtmlDiff } from "./Globals";


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
export function EscapeHtml(string) {
    return String(string).replace(/[&<>"'`=\/]/g, function (s) {
        return gReplaceEntityMap[s];
    });
}


export function RemoveStyle(string) 
{
    return String(string).replace(/\<style\>.*?\<\/style\>/gms, '');
}



export function FormatDate(date)
{
    const dateFormatOptions = {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false};
    return date.toLocaleDateString(undefined, dateFormatOptions);
}


export function GetIdentityName(identity) 
{
    return EscapeHtml(identity?.displayName ?? 'UNKNOWN NAME');
}


export function GetIdentityAvatarHtml(identity) 
{
    // According to the documentation (https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/identityreference),
    // 'imageUrl' is deprecated and '_links.avatar' should be used.
    const avatarUrl = identity?._links?.avatar?.href ?? '';
    const avatarHtml = avatarUrl ? `<img src="${avatarUrl}" class="inlineAvatar" alt="Avatar">` : '';
    return avatarHtml;
}


export function DiffHtmlText(oldValue, newValue) 
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