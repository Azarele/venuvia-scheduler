// Language of the conversation. The AI replies in the user's language by itself; this is
// for the messages our own code writes (approval cards, "Done — …" confirmations).
export type Lang = "en" | "pl";

const POLISH =
  /[ąćęłńóśźż]|\b(jutro|pojutrze|dzisiaj|dziś|wizyt\w*|rezerwacj\w*|termin\w*|przełóż|przesuń|zmień|odwołaj|anuluj|zarezerwuj|umów|godzin\w*|proszę|cofnij|poniedziałek|wtorek|środ\w*|czwart\w*|piąt\w*|sobot\w*|niedziel\w*)\b/i;

export function detectLanguage(text: string): Lang {
  return POLISH.test(text) ? "pl" : "en";
}
