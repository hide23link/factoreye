/**
 * 公開の文書（プライバシーポリシー・利用規約）を表示する画面。ログイン無しで読める。
 *
 * ⚠️ 本文は草案。法務の確認と、運営者（事業者）の情報の記入が済むまで、公開しないこと。
 * 「要確認」と書かれた箇所は、確定していない内容。
 *
 * 【誰が使うか】App.tsx が、URL が /privacy か /terms のときに出す。
 * 【引数（props）】kind = "privacy"（プライバシーポリシー）か "terms"（利用規約）。
 */

export type LegalKind = "privacy" | "terms";

const DRAFT_NOTICE = "この文書は草案です。法務の確認が済むまで、正式な文書として扱わないでください。";

const PRIVACY_SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "1. 事業者",
    body: ["事業者の名称・住所・連絡先は、正式に決まった後に掲載します（要確認）。"],
  },
  {
    title: "2. 取得する情報",
    body: [
      "アカウント情報: メールアドレス、パスワード（ハッシュ化して保存し、平文では保存しません）",
      "ワークスペース情報: ワークスペース名、ダッシュボード、ウィジェットの設定",
      "センサーの情報: センサー名、単位、しきい値、測定値（値と受信時刻）",
      "通知の設定: Discord 通知の送信先、Webhook の送信先（利用者が設定したもの）",
      "操作の記録: サーバーのログ（エラーや、管理者による操作の記録を含む）",
    ],
  },
  {
    title: "3. 利用目的",
    body: [
      "サービスの提供、不具合の調査、サポート",
      "無料プランの上限の管理（センサーの数、測定値の保存期間）",
      "セキュリティの維持（不正な利用の調査を含む）",
    ],
  },
  {
    title: "4. 運営者による閲覧（重要）",
    body: [
      "運営者（管理者）は、サポートや障害の調査のために、利用者のアカウント・ダッシュボード・設定・測定値を閲覧できます。",
      "運営者が利用者として画面を開いて、変更を行うこともあります。その場合、期限（15 分）付きで行い、管理者 ID と操作の内容をサーバーのログに記録します。",
      "（要確認: 運営者が閲覧・変更する根拠と、利用者への事前の告知の方法）",
    ],
  },
  {
    title: "5. 保存期間と削除",
    body: [
      "測定値は、無料プランでは 90 日より古いものから削除します。",
      "利用者がアカウントを削除すると、ワークスペースとそのデータ（センサー・測定値・ダッシュボード）は削除されます。",
      "（要確認: サーバーのログと、バックアップに含まれるデータの保存期間）",
    ],
  },
  {
    title: "6. 第三者への提供と外部への送信",
    body: [
      "利用者が設定した Discord・Webhook の送信先には、アラームやセンサーの値を送信します。送信先の管理は利用者の責任です。",
      "（要確認: サーバーの接続に使う外部サービス（Cloudflare など）の取り扱い）",
    ],
  },
  {
    title: "7. 問い合わせ",
    body: ["（要確認: 問い合わせ先）"],
  },
];

const TERMS_SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "利用規約",
    body: ["（準備中）利用規約の本文は、法務の確認の後に掲載します。"],
  },
];

export function LegalPage({ kind }: { kind: LegalKind }) {
  const title = kind === "privacy" ? "プライバシーポリシー" : "利用規約";
  const sections = kind === "privacy" ? PRIVACY_SECTIONS : TERMS_SECTIONS;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white px-4 py-2">
        <a href="/" className="text-lg font-bold">FactorEye</a>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-2 text-xl font-bold">{title}</h1>
        <p className="mb-6 rounded bg-amber-100 px-3 py-2 text-sm text-amber-900">{DRAFT_NOTICE}</p>
        {sections.map((section) => (
          <section key={section.title} className="mb-6">
            <h2 className="mb-2 text-base font-semibold">{section.title}</h2>
            {section.body.map((line) => (
              <p key={line} className="mb-2 text-sm leading-relaxed text-gray-700">
                {line}
              </p>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
