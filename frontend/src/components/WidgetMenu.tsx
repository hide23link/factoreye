/**
 * グラフ系ウィジェットの「⋮ メニュー」。全画面・表・CSV・リンクのコピーを 1 か所にまとめる。
 *
 * - ⋮ のボタンを押すと、項目の一覧（メニュー）が開く。開いたとき onOpen を呼ぶ（CSV のためのデータを取り直す）
 * - Esc・メニューの外のクリック・Tab で閉じる。↑↓・Home・End で項目を選び、Enter・Space で実行する。
 *   メニューが開いている間は、V（全画面）・T（表）のキーでも実行できる
 * - メニューはカードの外（document.body）に出す。カードは中身をはみ出させない（overflow-hidden）ため
 * - CSV は、データの取得が終わるまで押せない（取得中・失敗は、項目の横に出す）
 *
 * 【誰が使うか】WidgetCard が、グラフ系ウィジェットの右上に置く。
 * 【引数（props）】
 *   onOpen = メニューを開いたとき、
 *   onFullscreen = 「全画面で見る」、onToggleTable = 「データを表で見る」（tableShown = 今表が開いているか）、
 *   csv = CSV の状態（"loading" 取得中 / "ready" 保存できる / "error" 取得に失敗）、onSaveCsv = 「CSV を保存」、
 *   onCopyLink = 「この期間のリンクをコピー」（null ならこの項目を出さない。リンクで開けない種類のため）、
 *   className = ⋮ のボタンの外側の置き方。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface WidgetMenuProps {
  onOpen: () => void;
  onFullscreen: () => void;
  onToggleTable: () => void;
  tableShown: boolean;
  csv: "loading" | "ready" | "error";
  onSaveCsv: () => void;
  onCopyLink: (() => Promise<boolean>) | null;
  /** リンクの項目の下に出す注記（実際の動きの説明） */
  linkNote?: string;
  className?: string;
}

/** メニューの 1 項目 */
interface Item {
  id: string;
  label: string;
  hint?: string;
  key?: string;
  disabled?: boolean;
  run: () => void;
}

export function WidgetMenu(props: WidgetMenuProps) {
  const { onOpen, onFullscreen, onToggleTable, tableShown, csv, onSaveCsv, onCopyLink, linkNote, className } = props;
  const [open, setOpen] = useState(false);
  // 「コピーしました」を出している間の文字（null は出していない）
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // 「コピーしました」のあと閉じる待ち時間の予約。画面から消えるとき（アンマウント）に取り消す
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setCopyNotice(null);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const items: Item[] = [
    { id: "fullscreen", label: "全画面で見る", key: "V", run: () => { close(false); onFullscreen(); } },
    { id: "table", label: tableShown ? "表を閉じる" : "データを表で見る", key: "T", run: () => { close(true); onToggleTable(); } },
    {
      id: "csv",
      label: "CSV を保存",
      hint: csv === "loading" ? "取得中…" : csv === "error" ? "取得に失敗" : undefined,
      disabled: csv !== "ready",
      run: () => { close(true); onSaveCsv(); },
    },
    ...(onCopyLink
      ? [{
          id: "link",
          label: copyNotice ?? "この期間のリンクをコピー",
          run: () => {
            void onCopyLink().then((ok) => {
              setCopyNotice(ok ? "コピーしました" : "コピーできませんでした");
              closeTimer.current = window.setTimeout(() => close(true), 1200);
            });
          },
        }]
      : []),
  ];

  // 開いた直後は、ボタンの位置から出す場所を決め、先頭の項目にフォーカスする
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const box = buttonRef.current.getBoundingClientRect();
    setPosition({ top: box.bottom + 4, right: Math.max(4, window.innerWidth - box.right) });
  }, [open]);
  useEffect(() => {
    if (open && position) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    // 位置が決まったとき 1 回だけ（項目の文字が変わっても、フォーカスを奪わない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, position === null]);

  // メニューの外のクリック・画面の動きで閉じる
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    const onMove = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close]);

  const focusItem = (index: number) => {
    const nodes = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!nodes || nodes.length === 0) return;
    nodes[(index + nodes.length) % nodes.length]?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const nodes = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(current + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(current - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(nodes.length - 1);
    } else if (e.key === "Tab") {
      // ⋮ のボタンに戻して閉じる（Tab 自体は止める。次の Tab で、ボタンの次の場所へ進む）
      e.preventDefault();
      close(true);
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      // 頭文字のキー（V・T）
      const hit = items.find((item) => item.key !== undefined && item.key.toLowerCase() === e.key.toLowerCase());
      if (hit && !hit.disabled) {
        e.preventDefault();
        hit.run();
      }
    }
  };

  return (
    <div className={className}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="ウィジェットのメニュー"
        data-widget-menu-button
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="メニュー（全画面・表・CSV・リンク）"
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            close(false);
            return;
          }
          onOpen();
          setPosition(null);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          // ↓ でも開ける（キーボード操作）
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            e.currentTarget.click();
          }
        }}
        className={`widget-no-drag flex h-6 w-6 items-center justify-center rounded text-base font-bold leading-none hover:bg-gray-100 hover:text-gray-900 ${
          open ? "bg-gray-100 text-gray-900" : "text-gray-500"
        }`}
      >
        ⋮
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            tabIndex={-1}
            aria-label="ウィジェットのメニュー"
            onKeyDown={onMenuKeyDown}
            style={{ position: "fixed", top: position.top, right: position.right }}
            className="z-50 min-w-[12rem] max-w-[calc(100vw-8px)] rounded-md border border-gray-200 bg-white py-1 text-sm text-gray-800 shadow-lg"
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                onClick={() => {
                  if (!item.disabled) item.run();
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left focus:bg-blue-50 focus:outline-none ${
                  item.disabled ? "cursor-not-allowed text-gray-400" : "hover:bg-blue-50"
                }`}
              >
                <span className="flex-1">{item.label}</span>
                {item.hint && <span className="text-xs text-gray-500">{item.hint}</span>}
                {item.key && <kbd className="rounded border border-gray-200 px-1 font-num text-[10px] text-gray-500">{item.key}</kbd>}
              </button>
            ))}
            {onCopyLink && linkNote && <p className="border-t border-gray-100 px-3 pb-1 pt-1 text-[11px] text-gray-500">{linkNote}</p>}
          </div>,
          document.body,
        )}
    </div>
  );
}
