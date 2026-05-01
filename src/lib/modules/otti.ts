import { getDb } from '../db';
import { ensureCustomTables } from '../custom-tables';
import { getWorkspaceConfig, OTTI_WORKSPACE_CONFIG, seedWorkspaceConfig } from '../workspace-config';

export function initOttiModule() {
  seedWorkspaceConfig();
  const config = getWorkspaceConfig('otti');
  const tables = config.customTables?.length ? config.customTables : OTTI_WORKSPACE_CONFIG.customTables;
  ensureCustomTables(tables.filter((table) => table.module === 'otti' || table.id.startsWith('otti_')));
}

export function seedOttiUsers() {
  initOttiModule();
  const db = getDb();
  const users: [string, string, string][] = [
    ['U03DRPJSAGL', 'Arun V', 'Engineering'],
    ['U0AB8NZGWGY', 'Salvador Gallo', 'Product Support'],
    ['U08E107596K', 'Brittany Leclerc', ''],
    ['U09DG4MNARJ', 'Cody Towstik', 'Sr. Software Engineer'],
    ['U06M91QHS0P', 'Hemalatha K', 'Sr. Software Engineer (QA)'],
    ['U09TTU07X9R', 'Josh Rupert', 'PM - Partners'],
    ['U07RD1MNQPJ', 'Abhishek Goyal', 'Product Manager'],
    ['U09U09ZCSHY', 'Oswald Ochoa', 'Product Support L1'],
    ['U04H4UV2PDM', 'Joe Lombardi', 'Dir, Solutions Engineers'],
    ['U08QWTQ5WPL', 'Benjamin Covarrubias', 'Product Support'],
    ['U0378A39BKM', 'Vivek Rajwar', 'Engineering Manager'],
    ['U0415JPSLRF', 'Pampapati Shetty', 'Sr. Software Engineer - FE'],
    ['U07UJCQSMRP', 'Paulina Soto', 'Product Support L2'],
    ['U0A1TFB784T', 'Xochitl Torres', 'Product Support I'],
    ['U0A3ZP1P1DH', 'Gus Fernandes', 'Sr. Backend Engineer'],
    ['U097S5L33BM', 'Ameer', ''],
    ['U09TXRU84SC', 'Nicolas Battisti', 'Sr. Backend Developer'],
    ['U06NFNF3ZPG', 'Luke Detering', 'Principal PM'],
    ['UK2U1Q64S', 'Lena', 'Team Lead, Product Support'],
    ['U0398FCA3LZ', 'Rohit Gupta', 'Sr. Software Engineer (QA)'],
    ['U038ASQFM9B', 'Melissa Joukema', 'Sr. Manager, Product Support'],
    ['U05NBM1V46L', 'Raja Ram', 'Sr. Software Engineer (QA)'],
    ['U08RURGJR1R', 'Mahesh', 'SSE [Core]'],
    ['U02SHJG8U1J', 'Sushma Yadav', ''],
    ['U09JTS8QQKG', 'Chirag Shah', 'Sr. Software Engineer'],
    ['U09MDPP34N4', 'Varun Mhatre', ''],
    ['U089ZDCFUJJ', 'Elyse Williams', 'Sr. Manager, Customer Marketing'],
    ['U097UQVD28Y', 'David Bobadilla', ''],
    ['U09H0SAJC9L', 'Nishant Agarwal', ''],
    ['U09PWMF2XA4', 'Sai Charan', ''],
    ['U05A05LM547', 'Sembiyan', 'Lead PM, SRM & Spend'],
    ['U01EN687GHF', 'Kit Zorsch', 'Sr. Onboarding Specialist'],
    ['U06HHJ2R4PK', 'Abul Niyaz', 'Product Support'],
    ['U06T7HA1G0G', 'Bhakti Bhikne', 'Sr. Product Designer'],
    ['U02PB501KFT', 'Ben Spiegel', 'Product Management'],
    ['U096X31HPB5', 'Jeevanandam', ''],
    ['U019WEFQCLU', 'Kevin Leduc', 'Dir of Engineering'],
    ['U06KL4570', 'Krishna J', 'Engineering'],
    ['U0AL5FFD1D3', 'Jerry Love', 'Sr. PM - Integrations'],
    ['U086CUZE1FB', 'Puru Tiwari', 'Sr. Software Engineer'],
    ['U0A0L23G5FX', 'Mitul Rawat', 'Backend Developer'],
    ['U0998ARB9K4', 'Fayez Nazir', 'Solutions Architect'],
    ['U06UGHHB2TE', 'Eduardo Leon', 'Integrations Engineer'],
    ['U050VFGV7GT', 'Jake Hirsch', 'Solutions Engineer'],
    ['U05FZFKJUMT', 'Michael MacCormack', 'Staff Engineer'],
    ['U08ENQAMZG8', 'Eashan Bajaj', 'Sr. PM - Reports & AI'],
    ['U02NDR7JT0F', 'Ivan Zlatev', 'Sr. EM - Integrations'],
    ['U08AG9R403F', 'Harshil Khant', ''],
    ['U024TUMAEE9', 'Oliver Smith', 'Data Analyst'],
    ['U02SCC25XAR', 'Sumit Tawal', 'Engineer - V3 & Core'],
    ['U07JA9ETX7B', 'Kori Bowling', 'Enterprise CSM'],
    ['U04797AMJ78', 'Jess Law', 'Sr. Onboarding Specialist'],
    ['U0493MY38FM', 'Badal Harplani', 'SSE - VendorPay'],
    ['U054K8BV2TU', 'Nitin Mishra', 'SSE [Payment & Spend]'],
    ['U05DFM8P7HV', 'Chandresh Singh', 'Sr. Software Engineer - Core'],
    ['U07MDHP2WKW', 'Kanhaya Yadav', 'Software Engineer'],
    ['U09QGV6UE93', 'Anunaya Srivastava', 'Staff Software Engineer'],
    ['UQA3TQK2N', 'Collette Wojdylo', 'Manager, Onboarding'],
    ['UUDFU5BC3', 'Rupesh Mishra', 'Engineer'],
    ['U02QFB7UFPE', 'AJ Lightfoot', 'Team Lead, Product Support'],
    ['U07U5N2HUQJ', 'Jono Bowles', 'Product Management'],
    ['U08SKB6U9B8', 'Olivia Ivory', ''],
    ['UTLJPMYP8', 'Gayathri Raikar', 'SDET - VendorPay'],
    ['U03CYV8LFHB', 'Lenny Gumm', 'Team Lead, CS'],
    ['U06KKUQQECC', 'Manigandan Ganesan', 'EM - PaaS & Integrations'],
    ['U075X11DBKN', 'Hannia Mojica', 'Manager, Vendor Ops'],
    ['U09183EDR08', 'Peter Niu', 'PM - APIs and SDK'],
    ['U09ESA9UCA3', 'Prateek Mishra', 'Staff Software Engineer'],
    ['U09SX53J99R', 'Jason Boyles', 'Sr. Dir, Product Mgmt'],
    ['U0AHKD0G42C', 'Kajal', ''],
    ['U0AN1HW18TW', 'Anna Lobacheva', 'Principal PM - Payments'],
    ['U1X3U4656', 'Leah', 'Team Lead, Product Support'],
    ['U033SFRL45R', 'Kristopher Tapper', 'Integration Specialist'],
    ['U04478QTL7P', 'Jesus Oropeza', 'Technical Onboarding Mgr'],
    ['U04K9B74SSX', 'Sathya Viswanathan', 'Sr. Dir, Product Mgmt'],
    ['U04TMT11X0S', 'Stockton Sheehan', ''],
    ['U05K9D47SDQ', 'Matt Wallach', 'Partner Manager'],
    ['U0711AAB7UZ', 'Sam Suppipat', 'Manager, Enterprise CS'],
    ['U0774K8799P', 'Mariana Barragan', 'Product Support'],
    ['U098C77E6FP', 'Ushank R', 'Sr. Software Engineer'],
    ['U09PWMG0VME', 'Om Prakash', ''],
    ['U0A644HURB2', 'Zach Svendsen', ''],
    ['U0MKSTM1R', 'Arturo Inzunza', 'Engineer'],
    ['U02V8868VCY', 'Anchal Gupta', ''],
    ['U06A3EAHHAA', 'Gopika Sodani', 'Sr. Software Engineer - Core'],
    ['U06HXEH4QP5', 'Daniel Giaconi', 'Finance Manager'],
    ['U07HAUG5T89', 'Heather Wright', 'Enterprise CSM'],
    ['U09BUA66UF8', 'Paarth Bhatnagar', 'Sr. ML Engineer'],
    ['UT11YBBFC', 'Brandon Nembhard', 'Team Lead, Payment Ops'],
    ['U01FRT85H61', 'Savita Praveen', 'Engineering Manager'],
    ['U030Q4XLFH8', 'Stephanie Strange', 'Professional Services'],
    ['U03K2849G2X', 'Apoorva Rashmi', 'Dir, HR & Operations'],
    ['U041TLML0KX', 'Kartikeya Sharma', 'Sr. Software Engineer - BE'],
    ['U06JBN366DQ', 'Raeef', 'Customer Success Manager'],
    ['U06K6AXP8VC', 'Vivek Tiwari', 'Full Stack Engineer'],
    ['U078UNSDHK5', 'Daniel Hernandez', 'Assoc. Integrations Specialist'],
    ['U07A3DC0EC9', 'Swapnil Patil', 'PM - Core AP'],
    ['U08JCTCJD3R', 'Tatii Fairley', 'Onboarding Specialist'],
    ['U09B78DAJUW', 'Sanjanaa RS', 'Sr. Product Manager'],
    ['U09NPE6461X', 'Mel Faubert', 'Sr. Solutions Manager'],
    ['U0A0RBDGW', 'Erin Whitney', 'Dir, EDI & Data Ops'],
    ['US6V8C6TS', 'Pankaj Yadav', 'Sr. Software Engineer'],
  ];

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO otti_users (user_id, display_name, title) VALUES (?, ?, ?)'
  );
  for (const [uid, name, title] of users) {
    upsert.run(uid, name, title);
  }
}

export function seedOttiDeployments() {
  initOttiModule();
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as c FROM otti_deployments').get() as { c: number };
  if (existing.c > 0) return;

  db.prepare(
    "INSERT INTO otti_deployments (id, name, deploy_date) VALUES (?, ?, ?)"
  ).run('codemesh-v1', 'Codemesh Integration', '2026-04-15');
}

export function ensureOttiUsersTable() {
  initOttiModule();
}
