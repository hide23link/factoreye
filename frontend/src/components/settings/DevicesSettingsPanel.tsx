/**
 * 機器のパネル（設定画面「機器」）。OSS 版（self-hosted）だけで出す。
 *
 * 機器ごとのキー（X-Device-Key）の発行・センサーの所属・失効・削除を、画面でできる
 * （コマンド app/device_cli.py と同じ処理）。
 * - キーは作成した直後に 1 回だけ表示する。DB にはハッシュしか残らないので、あとから見る方法は無い
 * - あとから見分けられるよう、キーの先頭 6 文字を「目印」として出す（残りは保存していないので出せない）
 * - 失効すると、その機器のキーでの送信は 401 になる（センサーの所属は残る）
 * - 削除できるのは、失効した機器だけ。所属していたセンサーと測定値は残り、センサーは「機器なし」に戻る
 *
 * 【誰が使うか】SettingsPage.tsx が、OSS 版のときだけ「機器」のタブで出す。引数（props）はない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useDevices, useSensors } from "../../hooks/queries";
import { attachDeviceSensors, createDevice, deleteDevice, revokeDevice } from "../../lib/api";
import { describeDeviceError } from "../../lib/errors";
import { formatLastReceived } from "../../lib/time";
import type { Device, DeviceCreated } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorNotice } from "../ErrorNotice";

/** キーの目印の表示。先頭 6 文字だけを見せ、残りは伏せる。目印のない（古い）機器は「なし」。 */
function KeyHint({ hint }: { hint: string | null }) {
  if (hint === null) return <span className="text-gray-400">目印なし</span>;
  return (
    <span data-testid="key-hint" className="font-mono">
      {hint}••••••••
    </span>
  );
}

/** 作成直後のキーを 1 回だけ見せる小窓。「控えました」にチェックするまで閉じられない。 */
function KeyDialog({ created, onClose }: { created: DeviceCreated; onClose: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copyNote, setCopyNote] = useState("");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopyNote("コピーしました");
    } catch {
      setCopyNote("コピーできませんでした。キーを選択して控えてください");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="キーを控えてください" className="w-full max-w-md space-y-3 rounded-lg bg-white p-4 shadow-lg">
        <h3 className="text-base font-bold text-gray-900">キーを控えてください</h3>
        <p className="text-sm text-gray-700">
          機器 <b>{created.name}</b> を作りました。このキーは<b>この 1 回だけ</b>表示します。閉じると、もう見られません
          （あとからは、先頭の <KeyHint hint={created.keyHint} /> だけが目印として表示されます）。
        </p>
        <div data-testid="device-key" className="select-all break-all rounded border border-gray-200 bg-gray-50 p-2 font-mono text-sm">
          {created.key}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void copy()} className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50">
            コピー
          </button>
          <span className="text-xs text-gray-500">{copyNote}</span>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          控えました
        </label>
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!acknowledged}
            onClick={onClose}
            className="rounded bg-blue-600 px-3 py-1 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-40"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

/** 機器を追加するフォーム（機器名と、任意の系統）。 */
function AddDeviceForm({ onCreated, onCancel }: { onCreated: (created: DeviceCreated) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createDevice({ name: name.trim(), ...(line.trim() ? { line: line.trim() } : {}) }),
    onSuccess: onCreated,
    onError: (err) => setError(describeDeviceError(err, "機器の追加")),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        mutation.mutate();
      }}
      className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3"
    >
      <label className="flex flex-col gap-1 text-sm text-gray-600">
        機器名
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="例: atom07"
          className="rounded border border-gray-300 px-2 py-1 text-gray-900"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-gray-600">
        系統（任意）
        <input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          maxLength={40}
          placeholder="例: 第1ライン"
          className="rounded border border-gray-300 px-2 py-1 text-gray-900"
        />
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-white">
          キャンセル
        </button>
        <button
          type="submit"
          disabled={!name.trim() || mutation.isPending}
          className="rounded bg-blue-600 px-3 py-1 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-40"
        >
          追加してキーを発行
        </button>
      </div>
    </form>
  );
}

/** 選んだ機器の詳細（所属センサー・所属させる・失効・削除）。 */
function DeviceDetail({ device, unattached }: { device: Device; unattached: string[] }) {
  const queryClient = useQueryClient();
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const active = device.revokedAt === null;
  // 選んだセンサーが、再取得で一覧から消えていたら、先頭に戻す（古い選択を送らない）
  const picked = unattached.includes(pick) ? pick : (unattached[0] ?? "");

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["devices"] });
    void queryClient.invalidateQueries({ queryKey: ["sensors"] });
  };

  const attach = useMutation({
    mutationFn: () => attachDeviceSensors(device.id, [picked]),
    onSuccess: (result) => {
      setPick("");
      refresh();
      // 見つからなかったセンサーがあれば、成功とは見せない
      setError(result.missing.length > 0 ? `見つからないセンサーがありました: ${result.missing.join("、")}` : null);
    },
    onError: (err) => setError(describeDeviceError(err, "センサーの所属付け")),
  });

  const revoke = useMutation({
    mutationFn: () => revokeDevice(device.id),
    onSuccess: () => {
      setConfirmingRevoke(false);
      setError(null);
      refresh();
    },
    onError: (err) => {
      setConfirmingRevoke(false);
      setError(describeDeviceError(err, "キーの失効"));
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteDevice(device.id),
    onSuccess: () => {
      setConfirmingDelete(false);
      setError(null);
      refresh();
    },
    onError: (err) => {
      setConfirmingDelete(false);
      setError(describeDeviceError(err, "機器の削除"));
    },
  });

  return (
    <div className="space-y-4">
      <h3 className="font-mono text-base font-bold text-gray-900">{device.name}</h3>
      <dl className="grid grid-cols-[7em_minmax(0,1fr)] gap-y-1 text-sm">
        <dt className="text-gray-500">状態</dt>
        <dd>
          <span className={`rounded-full px-2 py-0.5 text-xs ${active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
            {active ? "有効" : "失効"}
          </span>
        </dd>
        <dt className="text-gray-500">系統</dt>
        <dd>{device.line ?? <span className="text-gray-400">なし</span>}</dd>
        <dt className="text-gray-500">最後の受信</dt>
        <dd>{formatLastReceived(device.lastReceivedAt)}</dd>
        <dt className="text-gray-500">キー</dt>
        <dd className="text-sm">
          <KeyHint hint={device.keyHint} />
          <span className="ml-2 text-xs text-gray-500">先頭 6 文字だけ表示します（全体は作成時の 1 回だけ）</span>
        </dd>
      </dl>

      <section>
        <h4 className="mb-1 text-xs font-bold text-gray-500">所属しているセンサー（この機器のキーでしか送れません）</h4>
        {device.sensors.length === 0 ? (
          <p className="text-sm text-gray-400">まだありません</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {device.sensors.map((key) => (
              <span key={key} className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-xs">
                {key}
              </span>
            ))}
          </div>
        )}
      </section>

      {active && (
        <section>
          <h4 className="mb-1 text-xs font-bold text-gray-500">センサーを所属させる（未所属のセンサー {unattached.length} 件）</h4>
          {unattached.length === 0 ? (
            <p className="text-sm text-gray-400">未所属のセンサーはありません</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="未所属のセンサー"
                value={picked}
                onChange={(e) => setPick(e.target.value)}
                className="min-w-0 rounded border border-gray-300 px-2 py-1 text-sm"
              >
                {unattached.map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={attach.isPending}
                onClick={() => attach.mutate()}
                className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                所属させる
              </button>
            </div>
          )}
        </section>
      )}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3">
        {active ? (
          <>
            <button
              type="button"
              onClick={() => setConfirmingRevoke(true)}
              className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50"
            >
              キーを失効
            </button>
            <span className="text-xs text-gray-500">漏れたとき・機器を外すときに使います（削除は、失効したあとに行えます）</span>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50"
            >
              この機器を削除
            </button>
            <span className="text-xs text-gray-500">失効済みです。再開するときは、新しい機器として作り直します。</span>
          </>
        )}
      </div>

      {confirmingRevoke && (
        <ConfirmDialog
          title="キーを失効しますか"
          message={`機器 ${device.name} のキーを失効します。この機器からの送信は 401 になります。元に戻せません。`}
          confirmLabel="失効する"
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate()}
          onCancel={() => setConfirmingRevoke(false)}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="機器を削除しますか"
          message={`機器 ${device.name} を削除します。所属していたセンサー（${device.sensors.length} 件）と測定値は消えません。センサーは「機器なし」に戻り、共通の API キーで送れる状態になります。元に戻せません。`}
          confirmLabel="削除する"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}

export function DevicesSettingsPanel() {
  const queryClient = useQueryClient();
  const devicesQuery = useDevices();
  const sensorsQuery = useSensors();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<DeviceCreated | null>(null);

  // 取得に失敗しても、すでに一覧があるあいだは画面を保つ（作成直後のキーの小窓を消さない）
  if (devicesQuery.isError && !devicesQuery.data) {
    return (
      <>
        <ErrorNotice message="機器の一覧を取得できませんでした。" onRetry={() => void devicesQuery.refetch()} />
        {created && <KeyDialog created={created} onClose={() => setCreated(null)} />}
      </>
    );
  }
  const devices = devicesQuery.data ?? [];
  const selected = devices.find((d) => d.id === selectedId) ?? devices[0] ?? null;
  const unattached = (sensorsQuery.data ?? []).filter((s) => !s.deviceId).map((s) => s.ingestKey);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-gray-900">機器</h2>
          <p className="text-sm text-gray-600">機器ごとのキーで送信を確かめます。キーが漏れたら、その機器だけ止められます。</p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-blue-700"
          >
            機器を追加
          </button>
        )}
      </div>

      {adding && (
        <AddDeviceForm
          onCancel={() => setAdding(false)}
          onCreated={(c) => {
            setAdding(false);
            setCreated(c);
            setSelectedId(c.id);
            void queryClient.invalidateQueries({ queryKey: ["devices"] });
          }}
        />
      )}

      {devicesQuery.isLoading ? (
        <p className="text-sm text-gray-500">読み込み中...</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-gray-500">機器がありません。「機器を追加」から作ります。</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <ul role="listbox" aria-label="機器の一覧" className="divide-y divide-gray-200 rounded-lg border border-gray-200">
            {devices.map((d) => (
              <li key={d.id} role="option" aria-selected={d.id === selected?.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(d.id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${d.id === selected?.id ? "bg-gray-100" : "hover:bg-gray-50"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono font-medium">{d.name}</span>
                    <span className="block text-xs text-gray-500">
                      <KeyHint hint={d.keyHint} />
                    </span>
                  </span>
                  <span className="text-xs text-gray-500">{d.sensors.length} センサー</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${d.revokedAt === null ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
                    {d.revokedAt === null ? "有効" : "失効"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <div className="rounded-lg border border-gray-200 p-3">
              <DeviceDetail key={selected.id} device={selected} unattached={unattached} />
            </div>
          )}
        </div>
      )}

      {created && <KeyDialog created={created} onClose={() => setCreated(null)} />}
    </div>
  );
}
