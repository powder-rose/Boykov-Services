import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const php = process.env.PHP_BIN || "php";
const probe = spawnSync(php, ["-r", "echo PHP_VERSION_ID;"], {
  encoding: "utf8",
});
const available =
  !probe.error && probe.status === 0 && Number(probe.stdout) >= 70000;
const file = fileURLToPath(
  new URL("../integrations/leads/nwd/hub.php", import.meta.url),
);

test(
  "NWD installer preserves the handler, inserts capture before commit and can be reapplied",
  { skip: !available },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nwd-hub-install-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, "site"),
      privateDir = join(directory, "private"),
      target = join(root, "custom/energo/modules/feedback");
    await mkdir(join(root, "redaktsiya/lib"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(
      join(root, "redaktsiya/lib/db.php"),
      `<?php function panelDb() {} function panelTable($name) {return $name;} function panelLanguage() {return 1;} function panelRow($query,$args) {return array('engine'=>'InnoDB');} function panelRows($query,$args) {return array();} function panelQuery($query,$args=array()) {}`,
    );
    const original = `<?php class Feedback_action {function add() { $receipt=array('feedback_id'=>1); $save=$receipt['feedback_id']; $repeated=false; $lead=nwdFeedbackLead(1,1); DB::query('COMMIT'); } }`;
    await writeFile(join(target, "feedback.action.php"), original);
    const installer = fileURLToPath(
      new URL("../integrations/leads/nwd/install.php", import.meta.url),
    );
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(php, [installer, root, privateDir], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /NWD_OUTBOX=INSTALLED/);
    }
    const updated = await readFile(join(target, "feedback.action.php"), "utf8");
    assert.equal(updated.split("BOYKOV_HUB_ENQUEUE_V1").length, 2);
    const capture = updated.indexOf("nwdHubEnqueue($lead, $requestId)");
    assert.ok(capture > 0 && capture < updated.indexOf("DB::query('COMMIT')"));
    const backups = await readdir(privateDir);
    const saved = await Promise.all(
      backups.map((name) =>
        readFile(join(privateDir, name, "feedback.action.php"), "utf8"),
      ),
    );
    assert.ok(saved.includes(original));
    assert.ok(
      (await readFile(join(target, "boykov-hub.php"), "utf8")).includes(
        "function nwdHubEnqueue",
      ),
    );
  },
);

test(
  "NWD PHP maps every form field and retains native creation time",
  { skip: !available },
  () => {
    const lead = {
      id: 6804,
      created: 1794993600,
      url: "https://nwdelectricity.ru/uslugi/",
      form: "Консультация",
      fields: [
        { label: "Ваше имя", type: "text", value: "Анна" },
        { label: "Телефон", type: "phone", value: "89991234567" },
        { label: "Электронная почта", type: "email", value: "test@example.ru" },
        {
          label: "Комментарий",
          type: "textarea",
          value: "Позвонить после 14:00",
        },
      ],
    };
    const code = `require ${JSON.stringify(file)}; $lead=json_decode(${JSON.stringify(JSON.stringify(lead))},true); echo json_encode(nwdHubPayload($lead));`;
    const result = spawnSync(php, ["-r", code], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.eventId, "feedback-6804");
    assert.equal(payload.phone, "89991234567");
    assert.equal(payload.name, "Анна");
    assert.equal(payload.fields.length, 4);
    assert.equal(Date.parse(payload.createdAt), lead.created * 1000);
  },
);
test(
  "NWD queue requires a saved matching snapshot and rejects conflicting repeated content",
  { skip: !available },
  () => {
    const code = `require ${JSON.stringify(file)};
    class DB {
      public static $saved=null;
      public static function query($sql,$id,$payload,$hash,$time) { if (self::$saved===null) self::$saved=array('payload_hash'=>$hash); }
      public static function query_fetch_array($sql,$id) {return self::$saved;}
    }
    $lead=array('id'=>1,'created'=>1794993600,'form'=>'Форма','fields'=>array(array('label'=>'Телефон','type'=>'phone','value'=>'89991234567')));
    nwdHubEnqueue($lead);nwdHubEnqueue($lead);
    $lead['fields'][0]['value']='89999999999';
    try {nwdHubEnqueue($lead);echo 'incorrect';exit(1);} catch (RuntimeException $e) {echo 'conflict-blocked';}`;
    const result = spawnSync(php, ["-r", code], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "conflict-blocked");
  },
);
