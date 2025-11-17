const axios = require("axios");

const ANKI_URL = "http://localhost:8765";
let requestQueue = Promise.resolve();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function enqueueRequest(task) {
  requestQueue = requestQueue
    .then(() => task())
    .catch((err) => {
      console.error("[Queue Error]:", err.message);
      // مهم: صف را زنده نگه دار تا promise chain خراب نشود
      return Promise.resolve();
    });
  return requestQueue;
}
async function ankiRequest(action, params = {}) {
  const payload = { action, version: 6, params };
  await delay(500); // اضافه کردن تاخیر کوچک بین درخواست‌ها

  return enqueueRequest(async () => {
    while (true) {
      try {
        const res = await axios.post("http://127.0.0.1:8765", payload, {
          timeout: 5000,
        });

        if (res.data.error) {
          const errMsg = res.data.error.toString();
          if (errMsg.includes("duplicate")) {
            console.warn(`⚠️ نوت تکراری (${action}) نادیده گرفته شد.`);
            return null; // صف ادامه می‌یابد ولی نوت تکراری skip می‌شود
          }
          throw new Error(errMsg);
        }

        console.log(`✅ ${action} انجام شد`);
        return res.data.result;
      } catch (err) {
        const msg = err.message || "";

        // فقط در خطاهای اتصال retry کن
        if (err.code === "ECONNRESET" || msg.includes("socket hang up")) {
          console.log("🔁 تلاش مجدد پس از 1 ثانیه...");
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        // خطای duplicate یا سایر خطاهای منطقی retry نمی‌خواهند
        if (msg.includes("duplicate")) {
          console.warn("⚠️ نوت تکراری رد شد (catch).");
          return null;
        }

        console.error(`[AnkiConnect Error] ${action}:`, msg);
        return null; // جلوی قفل صف را می‌گیرد
      }
    }
  });
}
async function reArrange() {
  await restHintsForDeck("EnToFa");
  await restHintsForDeck("FaToEn");
  await resetMain();
  await addNewEnWord();
  await delay(2000);
  await addNewFaWord();
  await ankiRequest("sync", {});
  //حذف تگ از کارتهای دگ های اصلی
  console.log(`[ankiConnect.js:66] reArrange completed!!!!!!!!!!!`);
}
// مرجع دک هینت
async function resetMain() {
  //یافتن کارت هایی که مرور بعدی آنها ۵ روز دیگر است
  let studiedHintCardsIds = await getStudiedHintCards();
  // return;
  if (studiedHintCardsIds.length === 0) {
    console.log(`[ankiConnect.js:60] No studied hint cards to process.`);
    return;
  }
  let noteIds = await getNoteIdsFromCardIds(studiedHintCardsIds);
  // noteIds = studiedHintCardsIds;

  //جدا سازی شده
  let notes = await ankiRequest("notesInfo", { notes: noteIds });
  let cardIdesToSetNowEnToFa = [];
  let cardIdesToSetNowFaToEn = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    console.log(`[ankiConnect.js:68]`, note.tags);
    if (note.tags.includes("EnToFa-AgainPressed")) {
      cardIdesToSetNowEnToFa.push(note.cards[0]);
    }
    if (note.tags.includes("FaToEn-AgainPressed")) {
      cardIdesToSetNowFaToEn.push(note.cards[1]);
    }
  }
  console.log(
    `[ankiConnect.js:86]`,
    cardIdesToSetNowEnToFa,
    cardIdesToSetNowFaToEn
  );
  await ankiRequest("removeTags", {
    notes: noteIds,
    tags: "EnToFa-AgainPressed FaToEn-AgainPressed",
  });
  await ankiRequest("changeDeck", {
    cards: cardIdesToSetNowEnToFa,
    deck: `1WordsForNewStudy::EnToFa`,
  });
  await ankiRequest("changeDeck", {
    cards: cardIdesToSetNowFaToEn,
    deck: `1WordsForNewStudy::FaToEn`,
  });
  await ankiRequest("forgetCards", { cards: studiedHintCardsIds });
  await ankiRequest("changeDeck", {
    cards: studiedHintCardsIds,
    deck: `TempFor1WordsForNewStudy`,
  });
  // await ankiRequest("setDueDate", {
  //   cards: cardIdesToSetNowEnToFa,
  //   days: "0!",
  // });

  // // await ankiRequest("forgetCards", { cards: cardIdesToSetNow });
  // await ankiRequest("removeTags", {
  //   notes: cardIdesToSetNowEnToFa,
  //   tags: "EnToFa-AgainPressed",
  // });
  // await ankiRequest("removeTags", {
  //   notes: cardIdesToSetNowFaToEn,
  //   tags: "FaToEn-AgainPressed",
  // });

  // console.log(
  //   `[ankiConnect.js:128] cards moved back to main decks from TempFor1WordsForNewStudy`
  // );
  // // await ankiRequest("suspend", { cards: studiedHintCardsIds });
}
async function getStudiedHintCards(params) {
  // استخراج کارت های خوب زده شده در ۳ روز گذشته برای آنها خوب یا راحت زده شده است ج
  // استخراج کارت هایی که
  let cardIds = await ankiRequest("findCards", {
    query: `note:"Meta-LEX-vR9" deck:"1WordsForNewStudy::Hint" card:"Hint" (rated:3:3 OR rated:3:4)`,
  });
  // استخراج کارت هایی که برای آنها اگر خوب یا عالی بزنمی بیشتر از ۵ روز بعد نمایش داده میشود دقت شود که این اعداد باید دقیق باشند برای حالت ۳ روز اولیه اگر در تنظیمات دک باید انجام شده باشد
  let cardsInfo = await ankiRequest("cardsInfo", { cards: cardIds });

  //   console.log(`[ankiConnect.js:70]`, cardsInfo, cardIds);
  let studiedCards = cardsInfo.filter((card) => {
    const nextReview = card.nextReviews[2];
    console.log(`[ankiConnect.js:103] nextReviews: `, card.nextReviews);
    let pas = false;
    if (nextReview.includes("mo")) pas = true;
    if (nextReview.includes("d")) {
      pas = true;
      // const clean = nextReview.replace(/[^\d.]/g, "");
      // const days = parseInt(clean);
      // if (days >= 5) pas = true;
    }
    return pas;
  });
  cardIds = studiedCards.map((c) => c.cardId);
  console.log(`[ankiConnect.js:118]hintCardIds to set suspend`, cardIds);
  return cardIds;
}
// مرجع دک اصلی
async function restHintsForDeck(deck) {
  let againPressedCards = await getAgainPressedCards(deck);
  console.log(
    `[ankiConnect.js:122] againPressedCards Ids: `,
    againPressedCards
  );
  let noteIds = await getNoteIdsFromCardIds(againPressedCards);
  // noteIds = await getNoteIdsWithoutTag(noteIds); // to remove notes that have again pressed tag
  // console.log(
  //   `[ankiConnect.js:97] noteIds for ${deck} to add tag then reset hints`,
  //   noteIds
  // );
  if (noteIds.length === 0) {
    console.log(`[ankiConnect.js:100] No noteIds to process for deck ${deck}`);
    return;
  }
  await ankiRequest("addTags", {
    notes: noteIds,
    tags: deck + "-AgainPressed",
  });
  let hintCards = await getCardsFromNoteIds(noteIds, "Hint");
  console.log(`[ankiConnect.js:137] hint cards to reset`, hintCards);
  // await ankiRequest("unsuspend", { cards });
  let ans = await ankiRequest("forgetCards", { cards: hintCards });
  await ankiRequest("changeDeck", {
    cards: hintCards,
    deck: `1WordsForNewStudy::Hint`,
  });

  let changed = await ankiRequest("changeDeck", {
    cards: againPressedCards,
    deck: `TempFor1WordsForNewStudy`,
  });

  await ankiRequest("forgetCards", { cards: againPressedCards });
  console.log(
    `[ankiConnect.js:155] cards moved from ${deck} to TempFor1WordsForNewStudy`
  );
}
async function getNoteIdsWithoutTag(noteIds) {
  let filteredNoteIds = [];
  for (let i = 0; i < noteIds.length; i++) {
    const id = noteIds[i];
    let tags = await ankiRequest("getNoteTags", { note: id });
    if (
      !tags.includes("EnToFa-AgainPressed") &&
      !tags.includes("FaToEn-AgainPressed")
    ) {
      filteredNoteIds.push(id);
    }
  }
  return filteredNoteIds;
}
async function getNoteIdsFromCardIds(cardIds) {
  const cardInfo = await ankiRequest("cardsInfo", {
    cards: cardIds,
  });
  const noteIds = cardInfo.map((c) => c.note);
  return noteIds;
}
async function getCardsFromNoteIds(noteIds, noteType) {
  const query = `(${noteIds
    .map((id) => `nid:${id}`)
    .join(" OR ")}) card:"${noteType}"`;
  const cards = await ankiRequest("findCards", { query });
  return cards;
}
async function getAgainPressedCards(deck) {
  /*
     یافتن کارتهایی که آخرین بار دگمه دوباره خورده
     با هر دک اصلی عملیات زیر انجام میشود
     ۱ انتخاب کارت هایی که در ۳ روز گذشته برای آنها دگمه دوباره خورد
     ۲ استخراج ریویو آنها و نه اینفو آنها آنها
     ۳ فیلتر آنهایی که مقدار  ایز ۱ دارند
     */

  let cardIdAgainPressed = await ankiRequest("findCards", {
    query: `note:"Meta-LEX-vR9" deck:"1WordsForNewStudy::${deck}" card:"${deck}" rated:3:1`,
  });
  let infoOfcardIdAgainPressed = await ankiRequest("getReviewsOfCards", {
    cards: cardIdAgainPressed,
  });

  const keysWithLastEase1 = Object.entries(infoOfcardIdAgainPressed)
    .filter(([key, arr]) => arr[arr.length - 1].ease === 1)
    .map(([key]) => Number(key));
  return keysWithLastEase1;
}
async function addNewEnWord() {
  const find = await ankiRequest("findCards", {
    query: `deck:"1WordsForNewStudy::EnToFa" (is:new OR is:due)`,
  });
  const maxCardsToAdd = 2;
  let diff = maxCardsToAdd - find.length;
  if (diff < 1) {
    console.log(
      `[ankiConnect.js:238] No need to add new cards. Current due/new cards: ${find.length}`
    );
    return;
  }
  // انتخاب  تعداد کارتها از دک تمپ به شرطی که ۲ تگ گفته شده را نداشته باشند
  let newCards = await ankiRequest("findCards", {
    query: `deck:TempFor1WordsForNewStudy -tag:EnToFa-AgainPressed -tag:FaToEn-AgainPressed card:EnToFa`,
  });
  //رندم کردن کارت ها
  newCards.sort(() => Math.random() - 0.5);
  newCards = newCards.slice(0, diff);
  await ankiRequest("changeDeck", {
    cards: newCards,
    deck: `1WordsForNewStudy::EnToFa`,
  });
}
async function addNewFaWord() {
  // انتخاب تمام کارتهای فارسی به انگلیسی که از دک تمپ که متاظر آنها در دک انگلیسی به فارسی به مرحله یادگیری رسیده است.

  let enToFaReviewCards = await ankiRequest("findCards", {
    query: `deck:"1WordsForNewStudy::EnToFa" is:review`,
  });
  let noteIds = await getNoteIdsFromCardIds(enToFaReviewCards);
  let faToEnCandidates = await ankiRequest("findCards", {
    query: `deck:TempFor1WordsForNewStudy -tag:EnToFa-AgainPressed -tag:FaToEn-AgainPressed card:FaToEn (${noteIds
      .map((id) => `nid:${id}`)
      .join(" OR ")})`,
  });
  await ankiRequest("changeDeck", {
    cards: faToEnCandidates,
    deck: `1WordsForNewStudy::FaToEn`,
  });
}
reArrange();
module.exports = { reArrange, ankiRequest };
