このバケット（factoreye-db）は、FactorEye の本番の DB のバックアップ専用です。WAL-G が管理します。手で、ファイルを置いたり消したりしないでください。

  wal_005/          WAL（DB の変更の履歴）。60 秒ごとに増えます。1 ファイル = 1 区切り
  basebackups_005/  ベースバックアップ（DB 全体の写し。毎日の差分と、週 1 回の全体）
                      base_<名前>/tar_partitions/<ファイル>  … 中身
                      base_<名前>_backup_stop_sentinel.json  … 完了の印（ある分だけが、使えるバックアップ）

フォルダ名は WAL-G が決めています（005 は保存形式の版）。変えられません。階層は、最大 3 段です。
古い分は、毎週の全体のバックアップのあと、自動で削除されます（全体を 1 世代だけ残す）。
復旧は、DR の控え（AWS）が、ここから自動で行います。手順は、factoreye の infra/walg/README.md と、ecopower の docs/aws-dr-wal-design.md。
