/**
 * 主题呈现（官方 @deepseek-ai/dsh-client-ui-layout ThemePresenter 等价物）。
 *
 * 官方 ui-layout 被禁用后，主题 token 应用职责由本插件接管：将
 * ctx.theme 快照投影到 document —— 根 `color-scheme`、body 暗色属性、
 * token 变量、theme-color meta。接口与官方完全一致，避免污染主题语义。
 */

/** Body attribute selecting the dark base palette in the token stylesheets. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme';

export type ThemeSnapshot = {
  active: {
    colorScheme: string;
    tokens: Record<string, string>;
  };
};

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  /** Token names this presenter wrote in the last apply (its retraction set). */
  appliedTokens: string[] = [];
  /** The single metadata node this presenter inserts and removes. */
  themeColorMeta: HTMLMetaElement;

  constructor() {
    this.themeColorMeta = document.createElement('meta');
    this.themeColorMeta.name = 'theme-color';
  }

  /**
   * Project a snapshot onto the document: set root `color-scheme` and the body
   * palette attribute from `active.colorScheme` (never the id — `system` is
   * resolved upstream), then replace the previously applied token variables
   * with `active.tokens`. Browser theme-color metadata follows the computed
   * body background after those writes, so the rendered palette remains the
   * color authority.
   */
  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme;
    document.documentElement.style.colorScheme = scheme;
    const body = document.body;
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '');
    else body.removeAttribute(DARK_ATTRIBUTE);
    for (const name of this.appliedTokens) body.style.removeProperty(name);
    this.appliedTokens = [];
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value);
      this.appliedTokens.push(name);
    }
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor;
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta);
  }

  /** Retract root color-scheme, the palette attribute, token variables, and the owned metadata node. */
  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme');
    const body = document.body;
    body.removeAttribute(DARK_ATTRIBUTE);
    for (const name of this.appliedTokens) body.style.removeProperty(name);
    this.appliedTokens = [];
    this.themeColorMeta.remove();
  }
}
