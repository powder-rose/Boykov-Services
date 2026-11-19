<?php
if(PHP_SAPI!=='cli' || !getenv('NATIVE_TEST_MYSQL_PORT'))exit(2);
mysqli_report(MYSQLI_REPORT_ERROR|MYSQLI_REPORT_STRICT);
$db=new mysqli('127.0.0.1','root','','boykov_native_stats_test',(int)getenv('NATIVE_TEST_MYSQL_PORT'));
$db->set_charset('utf8mb4');
function panelTable($name){return '`native_test_'.$name.'`';}
function panelRows($sql,array $values=array()){
 global $db;$s=$db->prepare($sql);if($values){$types='';foreach($values as $v)$types.=is_int($v)?'i':'s';$s->bind_param($types,...$values);}$s->execute();return $s->get_result()->fetch_all(MYSQLI_ASSOC);
}
$db->query('CREATE TEMPORARY TABLE native_test_panel_traffic_view(viewed_at INT,entry INT,article_site_id INT,path VARCHAR(500),source VARCHAR(160)) ENGINE=InnoDB');
$db->query('CREATE TEMPORARY TABLE native_test_feedback(created INT,trash CHAR(1)) ENGINE=InnoDB');
$db->query('CREATE TEMPORARY TABLE native_test_panel_article(site_id INT,title VARCHAR(500)) ENGINE=InnoDB');
$db->query("INSERT INTO native_test_panel_article VALUES(100,'Статья редакции')");
require __DIR__.'/../../integrations/statistics/nwd.php';
$now=strtotime('2026-11-19T13:34:50Z');$range=nwdStatisticsPeriod('24h',$now);
foreach(array($range['start']-1,$range['start'],$range['end']-1,$range['end']) as $time){
 $s=$db->prepare("INSERT INTO native_test_panel_traffic_view VALUES(?,1,100,'/zhurnal/test/','ref:yandex.ru')");$s->bind_param('i',$time);$s->execute();
 $s=$db->prepare("INSERT INTO native_test_feedback VALUES(?,'0')");$s->bind_param('i',$time);$s->execute();
}
$db->query('INSERT INTO native_test_feedback VALUES('.($range['start']+100).",'1')");
$db->begin_transaction(MYSQLI_TRANS_START_READ_ONLY|MYSQLI_TRANS_START_WITH_CONSISTENT_SNAPSHOT);
$value=nwdStatisticsPacket($now);$db->commit();echo json_encode($value,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
