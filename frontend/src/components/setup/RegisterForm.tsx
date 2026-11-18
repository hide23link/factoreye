/**
 * 段階 1「センサーを登録する」の入力欄（名前・Ingest Key・単位）。
 * 「次へ」の操作は、画面下の共通のボタン（form 属性でこの欄とつながる）が受け持つ。
 *
 * 【誰が使うか】SetupWizard。
 * 【引数（props）】formId = 下のボタンが指す id、値と変更の受け口（名前・Ingest Key・単位）、onSubmit = 送信。
 */
import { UnitSelect } from "../UnitSelect";

export interface RegisterFormProps {
  formId: string;
  name: string;
  onNameChange: (value: string) => void;
  ingestKey: string;
  onIngestKeyChange: (value: string) => void;
  unit: string;
  onUnitChange: (value: string) => void;
  onSubmit: () => void;
}

const FIELD_CLASS = "mt-1 block w-full rounded border border-gray-300 bg-white px-2 py-1";

export function RegisterForm(props: RegisterFormProps) {
  return (
    <form
      id={props.formId}
      className="mt-3 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <label className="block text-sm">
        名前
        <input value={props.name} onChange={(event) => props.onNameChange(event.target.value)} className={FIELD_CLASS} />
      </label>
      <label className="block text-sm">
        Ingest Key（デバイスが送信時に使う識別子）
        <input value={props.ingestKey} onChange={(event) => props.onIngestKeyChange(event.target.value)} className={`${FIELD_CLASS} font-num`} />
      </label>
      <label className="block text-sm">
        単位
        <UnitSelect value={props.unit} onChange={props.onUnitChange} className="mt-1 flex" />
      </label>
    </form>
  );
}
