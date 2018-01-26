import { makeRemotelyCallable } from 'src/util/webextensionRPC'
import { whenPageDOMLoaded, whenTabActive } from 'src/util/tab-events'
import { updateTimestampMetaConcurrent } from 'src/search'
import { blacklist } from 'src/blacklist/background'
import { logPageVisit, logInitPageVisit } from './log-page-visit'
import initPauser from './pause-logging'
import tabManager from './tab-manager'
import { isLoggable, getPauseState, visitKeyPrefix } from '..'

// `tabs.onUpdated` event fires on tab open - generally takes a few ms, which we can skip attemping visit update
const fauxVisitThreshold = 100

// Allow logging pause state toggle to be called from other scripts
const toggleLoggingPause = initPauser()
makeRemotelyCallable({ toggleLoggingPause })

/**
 * Combines all "logibility" conditions for logging on given tab data to determine
 * whether or not a tab should be logged.
 *
 * @param {tabs.Tab}
 * @returns {Promise<boolean>}
 */
async function shouldLogTab(tab) {
    // Short-circuit before async logic, if possible
    if (!tab.url || !isLoggable(tab)) {
        return false
    }

    // First check if we want to log this page (hence the 'maybe' in the name).
    const isBlacklisted = await blacklist.checkWithBlacklist()
    const isPaused = await getPauseState()

    return !isPaused && !isBlacklisted(tab)
}

/**
 * Handles update of assoc. visit with derived tab state data, using the tab state.
 *
 * @param {Tab} tab The tab state to derive visit meta data from.
 */
async function updateVisitForTab({ visitTime, activeTime, scrollState }) {
    const visitKey = visitKeyPrefix + visitTime

    try {
        await updateTimestampMetaConcurrent(visitKey, data => ({
            ...data,
            duration: activeTime,
            scrollPx: scrollState.pixel,
            scrollMaxPx: scrollState.maxPixel,
            scrollPerc: scrollState.percent,
            scrollMaxPerc: scrollState.maxPercent,
        }))
    } catch (error) {
        // If visit was never indexed for tab, cannot update it - move on
    }
}

// Ensure tab scroll states are kept in-sync with scroll events from the content script
browser.runtime.onMessage.addListener(
    ({ funcName, ...scrollState }, { tab }) => {
        if (funcName !== 'updateScrollState' || tab == null) {
            return
        }
        tabManager.updateTabScrollState(tab.id, scrollState)
    },
)

// Bind tab state updates to tab API events
browser.tabs.onCreated.addListener(tabManager.trackTab)

browser.tabs.onActivated.addListener(({ tabId }) =>
    tabManager.activateTab(tabId),
)

browser.tabs.onRemoved.addListener(tabId => {
    try {
        // Remove tab from tab tracking state and update the visit with tab-derived metadata
        const tab = tabManager.removeTab(tabId)
        updateVisitForTab(tab)
    } catch (error) {}
})

/**
 * The `webNavigation.onCommitted` event gives us some useful data related to how the navigation event
 * occured (client/server redirect, user typed in address bar, link click, etc.). Might as well keep the last
 * navigation event for each tab in state for later decision making.
 */
browser.webNavigation.onCommitted.addListener(
    ({ tabId, frameId, ...navData }) => {
        if (frameId === 0) {
            tabManager.updateNavState(tabId, {
                type: navData.transitionType,
                qualifiers: navData.transitionQualifiers,
            })
        }
    },
)

browser.tabs.onUpdated.addListener(async function(tabId, changeInfo, tab) {
    // `changeInfo` should only contain `url` prop if URL changed - what we care about for scheduling logging
    if (changeInfo.url) {
        try {
            // Ensures the URL change counts as a new visit in tab state (tab ID doesn't change)
            const oldTab = tabManager.resetTab(tabId, tab.active)
            if (oldTab.activeTime > fauxVisitThreshold) {
                // Send off request for updating that prev. visit's tab state, if active long enough
                updateVisitForTab(oldTab)
            }
        } catch (err) {}

        if (await shouldLogTab(tab)) {
            whenPageDOMLoaded({ tabId })
                .then(() => logInitPageVisit(tabId))
                .catch(console.error)

            tabManager.scheduleTabLog(
                tabId,
                () =>
                    // Wait until its DOM has loaded, and activated before attemping log
                    whenTabActive({ tabId })
                        .then(() => logPageVisit(tabId))
                        .catch(console.error), // Ignore any tab state interuptions
            )
        }
    }
})
