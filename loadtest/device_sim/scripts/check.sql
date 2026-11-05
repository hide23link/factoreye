-- 試験の結果の確認: 保存した測定値に、欠けも重複もないか。
--   使い方: psql -v since="'2026-10-30 11:00:00+00'" -f check.sql   （since = 試験の開始より少し前の時刻）
-- 各か所の電圧（-v）について、件数・時間の幅（秒）・重ならない時刻の数が一致していれば、欠け・重複なし。
select count(*) as sites, sum(n) as rows_v, min(n) as min_n, max(n) as max_n,
       sum(case when n = span_s and n = distinct_t then 1 else 0 end) as sites_without_gap_or_dup,
       sum(span_s - n) as missing_seconds_total
from (
  select s.ingest_key, count(*) as n,
         (extract(epoch from max(r.recorded_at) - min(r.recorded_at))::int + 1) as span_s,
         count(distinct r.recorded_at) as distinct_t
  from readings r join sensors s on s.id = r.sensor_id
  where s.ingest_key ~ '^ld[0-9]+-v$' and r.recorded_at >= :since
  group by s.ingest_key) x;
select 'total', count(*), count(distinct (sensor_id, recorded_at)) from readings;
