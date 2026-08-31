/**
 * client 半：白名单管理浮层（固定居中卡片，仿 WorkbenchEditor 授权面板样式）。
 *
 * - 条目列表：tokens 展示 + 粒度标签（命令名 / 子命令前缀 / 整行精确）+ 删除；
 * - 手动添加：命令输入 + 粒度选择（命令名 / 子命令前缀 token 数 / 整行精确）+ 添加；
 * - 清空全部。
 * 数据源 whitelistStore（与审批面板同实例），useSyncExternalStore 订阅实时刷新。
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { normalizeTokens } from './cmdWhitelist';
import { whitelistStore } from './whitelistStore';

/** 管理浮层 props。 */
export interface WhitelistManagerProps {
  /** 是否显示浮层 */
  open: boolean;
  /** 关闭回调（⚙ 按钮 / 遮罩 / Esc） */
  onClose: () => void;
}

/** 粒度标签（管理浮层与候选面板共用语义）。 */
function granularityLabel(tokenCount: number, exact: boolean): string {
  if (exact) return '整行精确';
  if (tokenCount === 1) return '命令名';
  return `子命令前缀 ${tokenCount}`;
}

/**
 * 白名单管理浮层。
 * @param props - WhitelistManagerProps
 * @returns 浮层元素（open=false 时返回 null）
 */
export function WhitelistManager(props: WhitelistManagerProps): React.JSX.Element | null {
  const { open, onClose } = props;
  const entries = useSyncExternalStore(
    whitelistStore.subscribe,
    () => whitelistStore.getEntries(),
    () => whitelistStore.getEntries(),
  );
  const [commandText, setCommandText] = useState('');
  const [prefixTokens, setPrefixTokens] = useState(2);
  const [granularity, setGranularity] = useState<'name' | 'prefix' | 'exact'>('exact');
  const [error, setError] = useState('');

  const tokens = useMemo(() => normalizeTokens(commandText), [commandText]);
  const maxTokens = tokens.length;

  const submit = (): void => {
    if (maxTokens === 0) {
      setError('请输入命令');
      return;
    }
    let tokenCount = maxTokens;
    let exact = true;
    if (granularity === 'name') {
      tokenCount = 1;
      exact = false;
    } else if (granularity === 'prefix') {
      tokenCount = Math.min(Math.max(1, prefixTokens), maxTokens);
      exact = false;
    }
    try {
      whitelistStore.addEntry(tokens, tokenCount, exact);
      setCommandText('');
      setError('');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  };

  if (!open) return null;

  return (
    <div className="dshDevWhitelistMask" onClick={onClose}>
      <div className="dshDevWhitelistCard" role="dialog" aria-label="命令白名单管理" onClick={(event) => event.stopPropagation()}>
        <div className="dshDevWhitelistHeader">
          <span>命令白名单</span>
          <button type="button" className="dshDevWhitelistClose" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dshDevWhitelistBody">
          {entries.length === 0 ? (
            <div className="dshDevWhitelistEmpty">暂无白名单条目。审批面板「永远允许」或在此手动添加。</div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="dshDevWhitelistRow">
                <span className="dshDevWhitelistRowCmd" title={entry.tokens.join(' ')}>
                  {entry.tokens.join(' ')}
                </span>
                <span className="dshDevWhitelistRowTag" data-broad={entry.exact ? undefined : true}>
                  {granularityLabel(entry.tokenCount, entry.exact)}
                </span>
                <button
                  type="button"
                  className="dshDevWhitelistRowDel"
                  aria-label={`删除 ${entry.tokens.join(' ')}`}
                  onClick={() => whitelistStore.removeEntry(entry.id)}
                >
                  删除
                </button>
              </div>
            ))
          )}
        </div>

        <div className="dshDevWhitelistAdd">
          <input
            className="dshDevWhitelistInput"
            placeholder="命令，如 mvn clean package -D maven.test.skip=true"
            value={commandText}
            onChange={(event) => {
              setCommandText(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
          <div className="dshDevWhitelistGran">
            <label className={granularity === 'name' ? 'dshDevWhitelistGranActive' : ''}>
              <input type="radio" name="gran" checked={granularity === 'name'} onChange={() => setGranularity('name')} />
              命令名
            </label>
            <label className={granularity === 'prefix' ? 'dshDevWhitelistGranActive' : ''}>
              <input type="radio" name="gran" checked={granularity === 'prefix'} onChange={() => setGranularity('prefix')} />
              子命令前缀
              <input
                type="number"
                min={1}
                max={Math.max(1, maxTokens)}
                value={prefixTokens}
                disabled={granularity !== 'prefix'}
                className="dshDevWhitelistGranNum"
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setPrefixTokens(Number(event.target.value))}
              />
            </label>
            <label className={granularity === 'exact' ? 'dshDevWhitelistGranActive' : ''}>
              <input type="radio" name="gran" checked={granularity === 'exact'} onChange={() => setGranularity('exact')} />
              整行精确
            </label>
          </div>
          {error !== '' && <div className="dshDevWhitelistError">{error}</div>}
          <div className="dshDevWhitelistActions">
            <button type="button" className="dshDevWhitelistClear" disabled={entries.length === 0} onClick={() => whitelistStore.clearAll()}>
              清空全部
            </button>
            <button type="button" className="dshDevWhitelistPrimary" onClick={submit}>
              添加
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
