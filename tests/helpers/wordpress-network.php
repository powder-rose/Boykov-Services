<?php
$GLOBALS['multisite']=true;
$GLOBALS['site_hosts']=array(1=>'unrelated.invalid',2=>'energo-365.ru',3=>'lp.energo-365.ru',
    4=>'energo-365.ru.attacker.invalid',5=>'office.msk.energo-365.ru',6=>'badenergo-365.ru');
$GLOBALS['cron'][4][Boykov_Leads_Plugin::HOOK]=123;
$controller = new Boykov_Leads_Plugin();
if ($mode === 'network-per-site') {
    switch_to_blog(3);
    try { $controller->activate(false); } finally { restore_current_blog(); }
    echo wp_json_encode(array('blog'=>get_current_blog_id(),'scheduled'=>$GLOBALS['cron'],
        'table'=>$wpdb->get_var("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wp_3_boykov_lead_outbox'")));
    return;
}
$controller->activate(true);
$activation = array('coordinator'=>get_site_option(Boykov_Leads_Plugin::COORDINATOR),
    'restored_blog'=>get_current_blog_id(), 'cron'=>$GLOBALS['cron']);
update_site_option('active_sitewide_plugins', array('boykov-leads/boykov-leads.php'=>time()));
update_site_option(Boykov_Leads_Plugin::CONFIG, $config);
$GLOBALS['network_transport']=true;
$objects=array();
foreach (array(2,3,5) as $id) {
    switch_to_blog($id);
    try {
        $objects[]=new Fixture_Submission(); $s=end($objects); $abort=false;
        $controller->capture(new Fixture_Form(),$abort,$s);
        if ($abort) { throw new RuntimeException('NETWORK_CAPTURE_ABORTED'); }
    } finally { restore_current_blog(); }
}
switch_to_blog(4);
try { $s=new Fixture_Submission(); $abort=false; $controller->capture(new Fixture_Form(),$abort,$s); $other_abort=$abort; }
finally { restore_current_blog(); }
switch_to_blog(2);
try {
    $first=$controller->run();
    $before=count($GLOBALS['network_heartbeats']);
    $wpdb->query('DROP TABLE wp_3_boykov_lead_outbox');
    $broken=$controller->run();
    $missing_stayed_missing=(int)$wpdb->get_var("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wp_3_boykov_lead_outbox'")===0;
    $GLOBALS['site_hosts'][9]='new.energo-365.ru';
    $controller->initialize_site((object)array('blog_id'=>9));
    switch_to_blog(9);
    try { $objects[]=new Fixture_Submission(); $s=end($objects);$abort=false;$controller->capture(new Fixture_Form(),$abort,$s); }
    finally { restore_current_blog(); }
    $after_new=$controller->run();
} finally { restore_current_blog(); }
$unrelated_tables=(int)$wpdb->get_var("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('wp_boykov_lead_outbox','wp_4_boykov_lead_outbox','wp_6_boykov_lead_outbox')");
echo wp_json_encode(array('activation'=>$activation,'first'=>$first,'heartbeats'=>$GLOBALS['network_heartbeats'],
    'first_heartbeat_count'=>$before,'payloads'=>$GLOBALS['network_payloads'],
    'tokens'=>array_values(array_unique($GLOBALS['network_tokens'])), 'other_aborted'=>$other_abort,
    'unrelated_tables'=>$unrelated_tables, 'broken'=>$broken, 'missing_stayed_missing'=>$missing_stayed_missing,
    'after_new'=>$after_new,'restored_blog'=>get_current_blog_id(),'local_config'=>get_option(Boykov_Leads_Plugin::CONFIG,null)));
