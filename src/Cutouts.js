// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { GetUserConfig } from './Configuration';
import { GenerateCutoutsWithContext, DeepCloneCutouts } from './GenerateCutoutsWithContext';

// @ts-ignore (webpack magic)
import ExpandSvg from '../images/divider-split-horizontal-icon.svg';


/** @type {?import('./HistoryDiffPageScript').AllUpdates} */
let gCurrentlyShownUpdates = null;

let gLineHeightInPixels = null;


/**
 * @param {import('./HistoryDiffPageScript').AllUpdates} updateHtml 
 * @param {Number} lineHeightInPixel 
 */
export async function InitializeCutouts(updateHtml, lineHeightInPixel)
{
    // TODO:
    // - React to window size changes?
    // - Reset USER_CONFIG_KEY to correct one (no 'temp')
    // - Test Firefox
    // - Test Cloud

    const userConfig = await GetUserConfig();
    const numContextLines = userConfig?.numContextLines ?? 0;
    
    // If the user wants zero context lines, we shouldn't show any just because there might be e.g. half a line
    // between cutouts. The user asked for zero context lines, so he or she gets it.
    // But otherwise we use the height of the cutout border (i.e. the height in the `cutout-border-base` class),
    // since that height is fixed and it would be weird if there were less actual content height "hidden" behind
    // the cutout border. (It would mean that by expanding the cutout border, the required space to display the
    // content shrinks instead of grows.)
    const mergingToleranceInPixel = numContextLines > 0 ? 20 : 0;

    let allCellPromises = [];
    for (let cellIdx = 0; cellIdx < updateHtml.allContentCells.length; ++cellIdx) {
        // singleUpdate.tdCell is a <td> element in the right column of the table, containing the info about a single update
        // and including <ins> and <del> elements. singleUpdate.divFullContent is the <div> in the <td> that contains the data.
        // They have already been inserted into the DOM, which is important for GenerateCutoutsWithContext() to work properly. 
        // Also, it is important to pass in the <div> rather than the <td> so that extents are measured only for the cell 
        // content rather than the whole cell.
        const singleUpdate = updateHtml.allContentCells[cellIdx];
        const promise = GenerateCutoutsWithContext(
                singleUpdate.divFullContent, ['ins', 'del'], numContextLines, lineHeightInPixel, mergingToleranceInPixel
            ).then(cutoutInfos => {
                singleUpdate.cutouts = cutoutInfos;
            });
        allCellPromises.push(promise);
    }
    await Promise.all(allCellPromises);

    gLineHeightInPixels = lineHeightInPixel;
    gCurrentlyShownUpdates = updateHtml;
}


export async function ShowOrHideUnchangedLinesDependingOnConfiguration()
{
    const userConfig = await GetUserConfig();
    if (userConfig?.showUnchangedLines) {
        ShowAllLines();
    } 
    else {
        ShowOnlyContextCutouts();
    }
}


/**
 * @param {import('./HistoryDiffPageScript').SingleUpdateCell} singleUpdateCell
 * @param {number} lineHeightInPixel
 */
function ReplaceHtmlChildrenOfCellWithCutouts(singleUpdateCell, lineHeightInPixel)
{
    const tdCell = singleUpdateCell.tdCell;
    tdCell.textContent = '';
    
    const cutoutInfos = singleUpdateCell.cutouts;
    if (!cutoutInfos || !cutoutInfos.cutouts) {
        tdCell.appendChild(singleUpdateCell.divFullContent);
        return;
    }
    
    const cutouts = cutoutInfos.cutouts;
    if (cutouts.length === 0) {
        const showContextButton = CreateShowContextButton();
        showContextButton.onclick = () => {
            tdCell.textContent = '';
            tdCell.appendChild(singleUpdateCell.divFullContent);
        };

        const text = document.createElement('i');
        text.textContent = '(Only whitespace or formatting changes not detected by diff algorithm.)';

        tdCell.append(showContextButton, text);
        return;
    }
    
    const finalCutout = cutouts[cutouts.length - 1];
    const firstCutoutStartsAtTop = cutouts[0].top <= 0;
    const finalCutoutEndsAtBottom = finalCutout.bottom >= cutoutInfos.originalHeight;

    if (cutouts.length === 1 && firstCutoutStartsAtTop && finalCutoutEndsAtBottom) {
        // Only 1 cutout containing everything => Simply show the full content directly.
        tdCell.appendChild(singleUpdateCell.divFullContent);
        return;
    }

    if (!firstCutoutStartsAtTop) {
        const numHiddenLines = Math.ceil(cutouts[0].top / lineHeightInPixel);
        tdCell.appendChild(CreateCutoutBorderDiv('cutout-border-at-top', numHiddenLines, singleUpdateCell, 0));
    }

    for (let cutoutIdx = 0; cutoutIdx < cutouts.length - 1; ++cutoutIdx) {
        tdCell.appendChild(cutouts[cutoutIdx].div);
        const numHiddenLines = Math.ceil((cutouts[cutoutIdx + 1].top - cutouts[cutoutIdx].bottom) / lineHeightInPixel);
        tdCell.appendChild(CreateCutoutBorderDiv('cutout-border-in-middle', numHiddenLines, singleUpdateCell, cutoutIdx + 1));
    }

    tdCell.appendChild(finalCutout.div);
    if (!finalCutoutEndsAtBottom) {
        const numHiddenLines = Math.ceil((cutoutInfos.originalHeight - finalCutout.bottom) / lineHeightInPixel);
        tdCell.appendChild(CreateCutoutBorderDiv('cutout-border-at-bottom', numHiddenLines, singleUpdateCell, cutouts.length));
    }

    for (const cutout of cutouts) {
        // For this to work, the cutout.div must be in the DOM.
        cutout.div.scroll({left: 0, top: cutout.top, behavior: "instant"});
    }
}


function ShowOnlyContextCutouts()
{
    if (!gCurrentlyShownUpdates || !gCurrentlyShownUpdates.allContentCells || !gLineHeightInPixels) {
        return;
    }

    for (const cell of gCurrentlyShownUpdates.allContentCells) {
        if (!cell.cutouts) {
            continue;
        }
        // If the cutouts had been modified by the user, restore them now. That way the user can restore
        // the original view by clicking on the 'toggle-context' button twice.
        if (cell.origCutouts) {
            cell.cutouts = cell.origCutouts;
            cell.origCutouts = null;
        }
        ReplaceHtmlChildrenOfCellWithCutouts(cell, gLineHeightInPixels);
    }
}


function ShowAllLines()
{
    if (!gCurrentlyShownUpdates || !gCurrentlyShownUpdates.allContentCells) {
        return;
    }

    for (const cell of gCurrentlyShownUpdates.allContentCells) {
        cell.tdCell.textContent = '';
        cell.tdCell.appendChild(cell.divFullContent);
    }
}


function CreateShowContextButton()
{
    const showContextButton = document.createElement('button');
    showContextButton.classList.add('button-in-cutout-border');
    showContextButton.title = 'Show hidden lines.';

    const img = document.createElement('img');
    img.classList.add('img-in-button-in-cutout-border');
    img.classList.add('img-invert-for-dark-mode');
    img.src = ExpandSvg;
    showContextButton.append(img);

    return showContextButton;
}


/**
 * @param {import('./HistoryDiffPageScript').SingleUpdateCell} singleUpdateCell
 */
function CreateCutoutBorderDiv(positionClass, numHiddenLines, singleUpdateCell, indexOfCutoutAfterwards)
{
    const showContextButton = CreateShowContextButton();

    const hiddenLinesText = document.createTextNode(
        numHiddenLines === 1 ? `1 hidden line` : `${numHiddenLines} hidden lines`);
    
    const borderDiv = document.createElement('div');
    borderDiv.classList.add('cutout-border-base');
    borderDiv.classList.add(positionClass);
    borderDiv.append(showContextButton, hiddenLinesText);

    showContextButton.onclick = () => {
        if (!gCurrentlyShownUpdates || !singleUpdateCell.cutouts
            || indexOfCutoutAfterwards < 0 || indexOfCutoutAfterwards > singleUpdateCell.cutouts.cutouts.length) {
            return;
        }

        // If we haven't done a backup of the original cutouts yet, do it now.
        if (!singleUpdateCell.origCutouts) {
            singleUpdateCell.origCutouts = DeepCloneCutouts(singleUpdateCell.cutouts);
        }

        if (indexOfCutoutAfterwards === 0) {
            const firstCutout = singleUpdateCell.cutouts.cutouts[0];
            const heightAddedAbove = firstCutout.top - borderDiv.getBoundingClientRect().height;

            firstCutout.top = 0;
            firstCutout.div.style.height = `${firstCutout.bottom}px`;
            
            // Keep the viewport constant on the cutout part that we had already shown.
            // Note: For the final cutout, this happens automatically. For middle cutouts, we obviously cannot have the cutout
            // below and above remain constant in the viewport simultaneously, since additional lines are shown in-between them.
            // So one has to jump. By doing nothing, the cutout above remains constant. => scrollBy() called only for the first cutout.
            document.documentElement.scrollBy({left: 0, top: heightAddedAbove, behavior: "instant"});
        }
        else if (indexOfCutoutAfterwards === singleUpdateCell.cutouts.cutouts.length) {
            const finalCutout = singleUpdateCell.cutouts.cutouts[singleUpdateCell.cutouts.cutouts.length - 1];
            finalCutout.bottom = singleUpdateCell.cutouts.originalHeight;
            finalCutout.div.style.height = `${finalCutout.bottom - finalCutout.top}px`;
        }
        else {
            const cutoutBefore = singleUpdateCell.cutouts.cutouts[indexOfCutoutAfterwards - 1];
            const cutoutAfter = singleUpdateCell.cutouts.cutouts[indexOfCutoutAfterwards];
            cutoutBefore.bottom = cutoutAfter.bottom;
            cutoutBefore.div.style.height = `${cutoutBefore.bottom - cutoutBefore.top}px`;
            singleUpdateCell.cutouts.cutouts.splice(indexOfCutoutAfterwards, 1);
        }

        // We need to scroll the elements to the correct position and remove the borderDiv. Moreover, we need to 
        // update the captured indices (i.e. the captured `indexOfCutoutAfterwards`) of the buttons coming after
        // our button. Or, simpler, we rebuild the whole cell.
        ReplaceHtmlChildrenOfCellWithCutouts(singleUpdateCell, gLineHeightInPixels);
    };

    return borderDiv;
}
