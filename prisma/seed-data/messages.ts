/*
 * The ready-made WhatsApp messages. They are only *created* by the seed — a message that exists is left alone, so Ahmad's edits survive a re-seed.
 * The fields in braces come from the contract, its worker, its client and the office (`{employee.first_name}`, `{contract.end_date}` …).
 */

export interface SeedMessage {
  code: string;
  name: string;
  audience: 'worker' | 'client';
  bodyNl: string;
  bodyEn: string;
}

export const SEED_MESSAGES: SeedMessage[] = [
  {
    code: 'contract_ending',
    name: 'Contract loopt af — vraag of het verlengd wordt',
    audience: 'worker',
    bodyNl: 'Hallo {employee.first_name}, je contract bij {client.name} loopt af op {contract.end_date}. Wil je graag verlengen? Laat het me weten. Groet, {office.name}',
    bodyEn: 'Hi {employee.first_name}, your contract at {client.name} ends on {contract.end_date}. Would you like to continue? Let me know. Kind regards, {office.name}',
  },
  {
    code: 'contract_notice',
    name: 'Contract eindigt — schriftelijke aanzegging volgt',
    audience: 'worker',
    bodyNl: 'Hallo {employee.first_name}, je contract bij {client.name} eindigt op {contract.end_date}. Binnenkort laten we je schriftelijk weten of het wordt voortgezet. Groet, {office.name}',
    bodyEn: 'Hi {employee.first_name}, your contract at {client.name} ends on {contract.end_date}. Soon we will let you know in writing whether it continues. Kind regards, {office.name}',
  },
  {
    code: 'contract_on_call_year',
    name: 'Oproepkracht na een jaar — vaste uren aanbieden',
    audience: 'worker',
    bodyNl: 'Hallo {employee.first_name}, je werkt nu bijna een jaar als oproepkracht bij {client.name}. We willen je een vast aantal uren aanbieden. Wanneer kunnen we even bellen? Groet, {office.name}',
    bodyEn: 'Hi {employee.first_name}, you have almost been working on call at {client.name} for a year. We would like to offer you a fixed number of hours. When can we call you? Kind regards, {office.name}',
  },
  {
    code: 'contract_signature',
    name: 'Contract ligt klaar om te ondertekenen',
    audience: 'worker',
    bodyNl: 'Hallo {employee.first_name}, je contract voor {client.name} ({contract.period_text}) ligt klaar om te ondertekenen. Kun je langskomen, of het ondertekend terugsturen? Groet, {office.name}',
    bodyEn: 'Hi {employee.first_name}, your contract for {client.name} ({contract.period_text}) is ready to be signed. Can you drop by, or send it back signed? Kind regards, {office.name}',
  },
  {
    code: 'contract_ended',
    name: 'Contract beëindigd — bedankt',
    audience: 'worker',
    bodyNl: 'Hallo {employee.first_name}, bedankt voor je werk bij {client.name}. Je contract is beëindigd per {contract.terminated_on}. Het allerbeste! {office.name}',
    bodyEn: 'Hi {employee.first_name}, thank you for your work at {client.name}. Your contract has ended on {contract.terminated_on}. All the best! {office.name}',
  },
  {
    code: 'client_contract_ending',
    name: 'Aan de klant: contract van een werknemer loopt af',
    audience: 'client',
    bodyNl: 'Beste {client.representative_name}, het contract van {employee.full_name} loopt af op {contract.end_date}. Wilt u het verlengen? Laat het ons weten. Groet, {office.name}',
    bodyEn: 'Dear {client.representative_name}, the contract of {employee.full_name} ends on {contract.end_date}. Would you like to extend it? Let us know. Kind regards, {office.name}',
  },
  {
    code: 'client_contract_notice',
    name: 'Aan de klant: aanzegging voor het einde van het contract',
    audience: 'client',
    bodyNl: 'Beste {client.representative_name}, het contract van {employee.full_name} eindigt op {contract.end_date}. Uiterlijk {contract.notice_deadline} moet de werknemer schriftelijk worden aangezegd. Zullen wij dat voor u regelen? Groet, {office.name}',
    bodyEn: 'Dear {client.representative_name}, the contract of {employee.full_name} ends on {contract.end_date}. The employee must be notified in writing by {contract.notice_deadline}. Shall we arrange that for you? Kind regards, {office.name}',
  },
];
