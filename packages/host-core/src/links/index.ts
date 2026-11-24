/**
 * Links a person can open: `wavecrux://` and `netcrux://`, and their editor
 * form `vscode://ferrite-engineering.<product>/open?…`, opened inside the
 * editor. See `flow.ts` for the order every link goes through.
 */
export {
  CRUX_LINK_FILE_KEY,
  CRUX_LINK_MAX_FILE_LENGTH,
  CRUX_LINK_MAX_LENGTH,
  CRUX_LINK_MAX_NAME_LENGTH,
  decodeLinkValue,
  encodeLinkValue,
  hasForbiddenLinkCharacter,
  looksLikeCruxLink,
  parseCruxLinkQuery,
  type CruxLinkGrammar,
  type CruxLinkGrammarRefusal,
  type CruxLinkQueryResult,
} from './grammar';
export {
  desktopLinkFromEditorUri,
  desktopLinkFromText,
  type DesktopLinkRewrite,
  type EditorLinkUri,
} from './rewrite';
export { isAbsolutePathText, isWindowsDeviceOrStream, refuseLinkPath } from './path-floor';
export {
  NODE_LINK_TARGET_FS,
  hasLinkExtension,
  vetLinkTarget,
  type LinkTargetFs,
  type LinkTargetOptions,
  type LinkTargetRefusal,
  type LinkTargetResult,
} from './target';
export { findOpenedPath, linkPathKey, type OpenedBeforeOptions } from './opened-before';
export { findCruxLinks, type DetectedCruxLink } from './detect';
export {
  openCruxLink,
  type CruxLinkFlow,
  type CruxLinkNotice,
  type CruxLinkOutcome,
  type CruxLinkParse,
} from './flow';
export {
  noticeText,
  openTabFilePaths,
  registerCruxLinks,
  vscodeCruxLinkFlow,
  type CruxLinkRegistration,
  type CruxLinkStrings,
} from './vscode-links';
