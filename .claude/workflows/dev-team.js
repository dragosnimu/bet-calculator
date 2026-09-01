export const meta = {
  name: 'dev-team',
  description: 'Echipa adversariala scriitor→tester→verificator: implementeaza/optimizeaza o sarcina si itereaza pana la teste verzi + GATE PASS (max 3 runde). Se opreste inainte de commit.',
  phases: [
    { title: 'Implementare', detail: 'dev-writer scrie/repara codul' },
    { title: 'Testare', detail: 'dev-tester ruleaza suita + ataca adversarial' },
    { title: 'Verificare', detail: 'code-auditor: QA + audit securitate, GATE' },
  ],
};

// Sarcina vine prin args: { task: "...", maxRounds?: n }  (sau args ca string simplu)
const task = (args && typeof args === 'object' && args.task) || (typeof args === 'string' ? args : null);
if (!task) {
  log('EROARE: nicio sarcina primita. Apeleaza cu args:{task:"..."}.');
  return { error: 'no-task' };
}
const MAX_ROUNDS = (args && args.maxRounds) || 3;

const TESTER_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'a trecut TOTUL, inclusiv testele adversariale?' },
    ran: { type: 'string', description: 'comenzi rulate + rezumat rezultate' },
    failures: { type: 'array', items: { type: 'string' }, description: 'esecuri concrete, cu reproducere' },
    newTests: { type: 'string', description: 'teste de regresie adaugate (daca e cazul)' },
  },
  required: ['pass', 'ran', 'failures'],
};

const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    gate: { type: 'string', enum: ['PASS', 'FAIL'] },
    highOrCritical: { type: 'number', description: 'numar de findings High sau Critical' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string' },
          title: { type: 'string' },
          location: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'title'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['gate', 'highOrCritical', 'findings', 'summary'],
};

let feedback = '';
const changelog = [];
let lastTester = null, lastVerifier = null;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  log(`════ Runda ${round}/${MAX_ROUNDS} ════`);

  // ---- 1) Scriitor ----
  phase('Implementare');
  const writerPrompt = round === 1
    ? `SARCINA de implementat/optimizat in C:\\dev\\bet-deploy:\n\n${task}\n\n` +
      `Implementeaz-o acum. Scop: corectitudine + securitate + cod curat, fara rescrieri masive. ` +
      `Verifica-ti munca (node --check pe modulele atinse, npm test). NU face git commit/push. ` +
      `La final rezuma exact ce fisiere ai schimbat, ce ai facut in fiecare si de ce.`
    : `Continui aceeasi sarcina in C:\\dev\\bet-deploy:\n\n${task}\n\n` +
      `FEEDBACK din runda anterioara (tester + verificator). REPARA obligatoriu tot ce e ` +
      `Critical/High si toate esecurile de teste; adreseaza Medium unde e rezonabil:\n\n${feedback}\n\n` +
      `Aplica fix-urile in cod, verifica-ti munca, NU face git commit/push. Rezuma ce ai schimbat.`;
  const writerOut = await agent(writerPrompt, { agentType: 'dev-writer', label: `scriitor r${round}`, phase: 'Implementare' });
  changelog.push({ round, writer: writerOut });

  // ---- 2) Tester adversarial ----
  phase('Testare');
  const tester = await agent(
    `Testeaza adversarial starea CURENTA a codului dupa modificarile pentru sarcina:\n\n${task}\n\n` +
    `Ruleaza npm test si node --check pe modulele atinse, apoi incearca ACTIV sa spargi codul nou ` +
    `(cazuri limita + input ostil pe fluxurile netrusted). Adauga teste de regresie durabile unde ` +
    `aduc valoare. Raporteaza pass/fail cu esecuri concrete. Modifica DOAR fisiere de test.`,
    { agentType: 'dev-tester', schema: TESTER_SCHEMA, label: `tester r${round}`, phase: 'Testare' }
  );
  lastTester = tester;

  // ---- 3) Verificator (audit adversarial) ----
  phase('Verificare');
  const verifier = await agent(
    `Fa audit adversarial (QA + securitate) pe starea CURENTA a codului dupa modificarile pentru ` +
    `sarcina:\n\n${task}\n\nUrmeaza metodologia ta completa (Faza 0→3). Intoarce: gate PASS/FAIL, ` +
    `numarul de findings High/Critical, lista de findings (severitate/titlu/locatie/fix) si un summary.`,
    { agentType: 'code-auditor', schema: VERIFIER_SCHEMA, label: `verificator r${round}`, phase: 'Verificare' }
  );
  lastVerifier = verifier;

  const green = !!(tester && tester.pass);
  const gatePass = !!(verifier && verifier.gate === 'PASS' && (verifier.highOrCritical || 0) === 0);
  log(`Runda ${round}: teste ${green ? 'VERZI ✅' : 'ROSII ❌'} · GATE ${verifier?.gate || '?'} (High/Crit: ${verifier?.highOrCritical ?? '?'})`);

  if (green && gatePass) {
    return {
      converged: true,
      rounds: round,
      summary: `Convergenta in ${round} runda/e: teste verzi + GATE PASS, fara High/Critical.`,
      changelog,
      tester,
      verifier,
    };
  }

  // Construieste feedback pentru scriitor (runda urmatoare)
  const failBlock = (tester && !tester.pass && (tester.failures || []).length)
    ? `ESECURI DE TESTE:\n- ${tester.failures.join('\n- ')}`
    : (tester && !tester.pass ? 'TESTE: pass=false (fara detalii de esec — investigheaza).' : '');
  const findBlock = verifier
    ? `AUDIT (${verifier.gate}, High/Crit ${verifier.highOrCritical}):\n` +
      (verifier.findings || []).map((f) => `- [${f.severity}] ${f.title}${f.location ? ' @ ' + f.location : ''}${f.fix ? ' → ' + f.fix : ''}`).join('\n')
    : '';
  feedback = [failBlock, findBlock].filter(Boolean).join('\n\n') || 'Fara feedback structurat; reinspecteaza.';
}

return {
  converged: false,
  rounds: MAX_ROUNDS,
  summary: `Nu a convers in ${MAX_ROUNDS} runde. Raportez esecurile/findings-urile ramase pentru decizie.`,
  changelog,
  tester: lastTester,
  verifier: lastVerifier,
};
