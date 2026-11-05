-- 試験データの削除: 試験で作ったセンサー（ld<NN>-v/-i/-e。測定値・アラームも連なって消える）と機器（r-load-<NN>）だけを消す。
select 'before', (select count(*) from sensors), (select count(*) from readings), (select count(*) from ingest_devices);
delete from sensors where ingest_key ~ '^ld[0-9]+-[vie]$';
delete from ingest_devices where name ~ '^r-load-[0-9]+$';
select 'after', (select count(*) from sensors), (select count(*) from readings), (select count(*) from alarms), (select count(*) from ingest_devices);
