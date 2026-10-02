# Uzgrow — mijozlar va xodimlar uchun Telegram botlar

Tizim ikki bot va xodimlar uchun Telegram Mini App'dan iborat:

| Qism | Kim uchun | Nima qiladi |
|---|---|---|
| **Mijozlar boti** — @uzgroww_bot | Mijozlar | Juda sodda: mijoz xodimning shaxsiy havolasi (masalan `https://t.me/uzgroww_bot?start=aziza`) orqali kirsa, hech narsa tanlamasdan darhol o'sha xodim bilan chat boshlanadi. Oddiy `/start` da operator yoki menejer tanlanadi (rasm, lavozim, tavsif, onlayn holati bilan). Mijoz xodimga birinchi marta yozganda bot standart avto-javob beradi, keyin xodimning o'zi javob yozadi. |
| **Xodimlar boti** — @uzgrow_staff_bot | Operator, menejer, admin, ROP, developer | Mijoz xabarlari shu botga keladi. Chatlar ro'yxati, tarix, javob berish, onlayn/oflayn holat. **⚙️ Admin panel**: xodim qo'shish, tahrirlash, bloklash, o'chirish; ROP uchun **mijozlarga ommaviy xabar** va **shikoyatlar**; developer uchun **🛠 Developer panel**. |
| **Mini App («💬 Chatlar»)** | Xodimlar va admin | Telegram ichida ochiladigan ilova: Telegram'ga o'xshash chat oynasi, profil (shaxsiy havola bilan) va admin panel. Mijozlar uchun Mini App yo'q — ular faqat bot chatida yozadi. |

**Maxfiylik.** Har bir suhbatni faqat mijoz va u tanlagan xodim ko'radi. Boshqa xodimlar ham, admin ham suhbat matnini ko'ra olmaydi. Yagona istisno: mijoz shikoyat qilgan suhbatni **ROP va developer** shikoyatni tekshirish uchun faqat o'qiy oladi.

**Saqlash.** Barcha xabarlar Supabase bazasida saqlanadi.

**Mijoz qaysi usulda yozishi.** Faqat bot chatida. Har bir xodimning mijozlar uchun shaxsiy havolasi bor (xodim kartasida, «👤 Profilim» da va Mini App da) — uni mijozga bering.

---

## 1. Tayyorgarlik

Kerakli hamma narsa tayyor, token va kalitlar lokal `.env` faylida turibdi:
- mijozlar boti tokeni;
- xodimlar boti tokeni;
- Supabase bazasi (jadvallar yaratilgan);
- developer ID: `6562925011` (`ADMIN_IDS` — developer(lar); admin va ROP bot ichidan qo'shiladi).

> `.env` faylini hech qachon GitHub yoki boshqa ochiq joyga yuklamang. U `.gitignore` da turibdi.

## 2. Vercel'ga joylash

Loyiha papkasida terminal oching va quyidagilarni bajaring.

1. **Loyihani Vercel'ga bog'lang:**
   ```bash
   vercel link
   ```
   Savollarga javob bering: loyihani sozlash → **Y**, mavjud loyihaga ulash → **N** (yangi loyiha), nomi masalan `uzgrow-bot`. Qolgan sozlamalarni o'zgartirmang: `vercel.json` hammasini belgilaydi, jumladan Supabase'ga yaqin **syd1** (Sidney) regionini.

2. **Env o'zgaruvchilarni kiriting.**
   - Vercel → loyiha → **Settings → Environment Variables** ga kiring.
   - `.env` faylini oching, `#` bilan boshlanmagan hamma qatorlarni nusxalab, birinchi «Key» maydoniga joylang. Vercel ularni o'zi alohida o'zgaruvchilarga ajratadi.
   - Environment sifatida **Production** ni belgilang va **Save** bosing.

   | O'zgaruvchi | Majburiymi | Izoh |
   |---|---|---|
   | `CLIENT_BOT_TOKEN` | ✅ | Mijozlar boti tokeni |
   | `STAFF_BOT_TOKEN` | ✅ | Xodimlar boti tokeni |
   | `DATABASE_URL` | ✅ | Supabase pooler manzili (port 6543), `.env` dagidek aynan nusxalang |
   | `WEBHOOK_SECRET` | ✅ | Tasodifiy maxfiy satr (`.env` da tayyor) |
   | `ADMIN_IDS` | ✅ | **Developer** Telegram ID lari, vergul bilan (barcha huquqlar). Admin va ROP bot ichidagi 🛠 Developer paneldan qo'shiladi |
   | `APP_URL` | — | Bo'sh qolsa, Vercel production domeni avtomatik olinadi |
   | `SETUP_KEY` | — | Faqat HTTP orqali sozlash kerak bo'lsa (pastga qarang) |

3. **Production'ga deploy qiling:**
   ```bash
   vercel --prod
   ```
   Oxirida `https://uzgrow-bot-xxxx.vercel.app` ko'rinishidagi **Production** manzilini ko'rasiz. Aniq domenni Vercel → loyiha → **Domains** bo'limida ham ko'rish mumkin.

## 3. Botlarni ulash (bir marta)

Deploy tugagach, **o'z kompyuteringizdan** shu buyruqni bering (domenni o'zingiznikiga almashtiring):

```bash
npm run setup -- https://uzgrow-bot.vercel.app
```

Bu buyruq quyidagilarni bajaradi:
- bazani joriy sxemaga yangilaydi;
- ikkala botning webhooklarini o'rnatadi (maxfiy token bilan);
- bot buyruqlarini, bot tavsiflarini va menyu tugmalarini o'rnatadi (mijozlar botida — buyruqlar ro'yxati, xodimlar botida — «💬 Chatlar» Mini App).

Hammasi to'g'ri bo'lsa ikkala bot yonida ✅ chiqadi. Botlar holatini istalgan vaqtda ko'rish mumkin (bu buyruq hech narsani o'zgartirmaydi):

```bash
npm run setup -- --info
```

> Muqobil yo'l, kompyutersiz: Vercel'da `SETUP_KEY` (kamida 16 belgi, `WEBHOOK_SECRET` dan farqli) qo'shing va qayta deploy qiling. Keyin quyidagini ishga tushiring:
> `curl -X POST -H "Authorization: Bearer <SETUP_KEY>" https://uzgrow-bot.vercel.app/api/setup`
> Kalit URL ichida emas, faqat shu sarlavhada yuboriladi.

## 4. Xodimlarni qo'shish (admin)

1. @uzgrow_staff_bot ga `/start` yozing. Admin bo'lganingiz uchun **⚙️ Admin panel** tugmasi chiqadi.
2. **➕ Xodim qo'shish** ni bosing va ketma-ket kiriting: rol (Operator/Menejer) → ism → lavozim → tavsif → avto-javob matni → rasm. Lavozim, tavsif, avto-javob va rasmni o'tkazib yuborish mumkin.
3. Bot **taklif havolasi** beradi. Uni o'sha xodimga yuboring. Xodim havolani ochib **Start** bosganda uning Telegram akkaunti profilga ulanadi va u mijozlarga ko'rina boshlaydi.
4. Xodimning **mijozlar uchun havolasi** ismidan avtomatik yaratiladi (`?start=aziza`). Uni kartadagi «✏️ Havola nomi» tugmasi (yoki Mini App dagi «Havola nomi» maydoni) bilan o'zgartirish mumkin: 2–32 ta lotin harfi, raqam yoki `_`. Nom o'zgarsa, eski havola ishlamay qoladi.
5. Xodimni istalgan vaqtda tahrirlash, rasmini almashtirish, bloklash (🚫), akkauntini uzish yoki o'chirish mumkin. Buni botda ham, Mini App dagi **⚙️ Admin** bo'limida ham qilsa bo'ladi. Xodim o'chirilsa ham suhbatlar tarixi saqlanib qoladi.

> Mijozlarga faqat **faol** va **akkaunti ulangan** xodimlar ko'rinadi. Admin ro'yxatida ⏳ belgisi akkaunt hali ulanmaganini bildiradi.

**Bot matnlari.** Admin panel → «👋 Salomlashuv matni», «🤖 Avto-javob matni», «🕐 Oflayn izohi». Matnlarda `{name}` o'rniga mijoz ismi, `{staff}` o'rniga xodim ismi qo'yiladi. Har bir xodim uchun alohida avto-javob matni ham yozish mumkin.

## 4.1. Rollar: developer, ROP, admin

| Rol | Kim | Nima qila oladi |
|---|---|---|
| 🛠 **Developer** | `ADMIN_IDS` dagi ID (hozir `6562925011`) | Hamma narsa + **🛠 Developer panel**: admin va ROP qo'shish/olib tashlash, tizim holati (webhooklar, baza, statistika) |
| 👑 **ROP (rahbar)** | Developer qo'shadi | To'liq admin paneli + **📣 Mijozlarga xabar** (barcha mijozlarga ommaviy xabar) + **⚠️ Shikoyatlar** (ro'yxat, shikoyat qilingan suhbatni o'qish, «✅ Hal qilindi») |
| ⚙️ **Admin** (1–2 ta) | Developer qo'shadi | To'liq admin paneli: xodim qo'shish, tahrirlash, **bloklash**, o'chirish, havolalar, bot matnlari, statistika + **📣 Mijozlarga xabar** |

**Admin yoki ROP qo'shish:** @uzgrow_staff_bot → «⚙️ Admin panel» → «🛠 Developer panel» → «➕ Admin qo'shish» / «➕ ROP qo'shish» → o'sha odamning **Telegram ID** raqamini yuboring (u @userinfobot orqali biladi) yoki uning biror xabarini forward qiling. So'ng u @uzgrow_staff_bot ga `/start` yozadi va «⚙️ Admin panel» chiqadi. Olib tashlash — «👥 Adminlar va ROP» ro'yxatidan.

**Ommaviy xabar (admin / ROP / developer):** «📣 Mijozlarga xabar» → matn, rasm, video, fayl yoki ovozli xabar yuboring → bot oldindan ko'rsatadi va «N ta mijozga yuborilsinmi?» deb so'raydi → «✅ Yuborish». Jarayon xabari yuborilganlar, botni bloklaganlar va xatolar sonini ko'rsatib boradi; «✖️ To'xtatish» bilan to'xtatish mumkin. Telegram limiti sababli ~25 ta xabar/soniya (1 000 mijoz ≈ 40 soniya).

**Shikoyatlar:** mijoz `/shikoyat` → yozishgan xodimini tanlaydi → shikoyat matnini yozadi. Shikoyat **xodimga ko'rinmaydi**; ROP va developerga darhol bildirishnoma keladi. «⚠️ Shikoyatlar» da ko'rib chiqib «✅ Hal qilindi» bosilsa, mijozga «shikoyatingiz ko'rib chiqildi» xabari boradi.

## 5. Qanday ishlaydi

**Mijoz:**
- Xodimning shaxsiy havolasi orqali kirsa — darhol o'sha xodim bilan chat boshlanadi (xodim rasmi va «Siz … bilan bog'landingiz» xabari), hech narsa tanlash shart emas.
- Oddiy `/start` → «👨‍💻 Operatorlar» yoki «👔 Menejerlar» → xodim kartochkasi (rasm, lavozim, tavsif, ◀️ ▶️ bilan varaqlash) → **✍️ Yozish**.
- Matn, rasm, video, fayl, ovozli xabar, stiker, joylashuv yoki kontakt yuborishi mumkin.
- Birinchi xabariga bot bir martalik avto-javob beradi, keyin xodimning javoblari xodim ismi bilan keladi.
- Boshqa xodimga o'tish uchun `/start`. Xodimning xabariga **Reply** qilsa (yoki «↩️ Javob berish» ni bossa), javob aynan o'sha xodimga boradi.
- Xodim ustidan shikoyat qilish: `/shikoyat`.
- Pastki doimiy menyu va Mini App yo'q — bot iloji boricha sodda.

**Xodim:**
- Mijoz xabari @uzgrow_staff_bot ga mijoz ismi bilan keladi. Javob berishning uch yo'li bor:
  - xabarga **Reply** qilish;
  - xabar ostidagi **↩️ Javob berish** tugmasini bosib, keyin yozish;
  - **💬 Chatlar** → mijozni tanlab, keyin yozish.
- Yuborilgan xabarga 👍 reaksiyasi qo'yiladi, bu «yetkazildi» degani. Qaysi mijozga ekanini aniqlab bo'lmasa, bot «❓ Bu xabar kimga?» deb so'raydi va xabarni tasodifiy odamga yubormaydi.
- **🔄 Holat** tugmasi onlayn/oflayn holatni almashtiradi. Oflayn bo'lsa, avto-javobga «hozir ish joyida emas» izohi qo'shiladi.
- **💬 Chatlar** (Mini App) — Telegram'ga o'xshash chatlar ro'yxati: qidiruv, o'qilmagan xabarlar soni, rasmlar va fayllar.
- Xabar tahrirlansa, qarshi tomondagi nusxa ham yangilanadi.
- Xodim botni to'xtatib qo'ysa, xabarlar saqlanib turadi, adminlarga ogohlantirish boradi va xodim qaytganda xabarlar yetkaziladi.

## 6. Lokal ishlab chiqish va testlar

```bash
npm install
npm run typecheck      # TypeScript tekshiruvi
npm run test:fake      # soxta Telegram serverining o'z testlari
npm test               # to'liq e2e testlar (~25 daqiqa)
npm run dev            # lokal server: http://127.0.0.1:3000  (npm run dev -- --links — Mini App ni brauzerda sinash havolalari)
```

`npm test` production ma'lumotlariga tegmaydi. U soxta Telegram server va vaqtinchalik `e2e_test` sxemasida ishlaydi, sxema test oxirida o'chiriladi.

**Loyiha tuzilishi:**
```
api/            Vercel funksiyalari: client-bot, staff-bot (webhooklar), app (Mini App API), media, setup
src/            yadro: relay (xabar uzatish), repo (baza), tg (Telegram), auth, schema, ...
src/bots/       mijozlar boti, xodimlar boti, admin panel
src/webapp/     Mini App backend
public/app/     Mini App (HTML/CSS/JS)
scripts/        setup, migrate, dev-server
tests/          e2e testlar + soxta Telegram server
```

## 7. Xavfsizlik

- Webhooklar maxfiy token bilan himoyalangan. Mini App so'rovlari Telegram imzosi (initData) orqali tekshiriladi, media havolalari vaqtinchalik imzo bilan beriladi.
- Supabase'dagi barcha jadvallarda RLS yoqilgan, ya'ni publishable (anon) kalit bilan ma'lumotlarni o'qib bo'lmaydi. Server bazaga to'g'ridan-to'g'ri ulanadi.
- Spamdan himoya: mijoz va xodim xabarlari tezligi cheklangan.
- Token yoki parol oshkor bo'lib qolsa:
  - token → @BotFather → `/revoke`;
  - Supabase paroli → Supabase → Settings → Database.
  
  So'ng Vercel'dagi qiymatlarni yangilab, `npm run setup -- https://...` ni qayta ishga tushiring.

## 8. Muammolar bo'lsa

- **Bot javob bermayapti.** `npm run setup -- --info` ni ishga tushiring: webhook manzili va oxirgi xato ko'rsatiladi. Vercel → loyiha → **Logs** bo'limini ham ko'ring.
- **Mijozlarga xodim ko'rinmayapti.** Xodim taklif havolasini ochib, xodimlar botida **Start** bosganmi? Admin ro'yxatida ⏳ belgisi akkaunt ulanmaganini bildiradi.
- **Xodimga xabar kelmayapti.** Xodim botni to'xtatmaganmi? Xabarlar baribir saqlanadi va Mini App dagi «💬 Chatlar» da ko'rinadi. Xodim botga qaytganda xabarlar avtomatik yetkaziladi.
- **Mini App ochilmayapti.** `npm run setup -- https://<production-domen>` ni qayta ishga tushiring. Vaqtinchalik (preview) manzillar Vercel tomonidan himoyalangan, faqat production domenini ishlating.

## 9. Quvvat va tariflar (o'lchangan)

Bosim testida (500 tagacha bir vaqtda yozgan mijoz, Telegram cheklovlari simulyatsiyasi bilan) **birorta xabar yo'qolmadi, takrorlanmadi yoki noto'g'ri odamga bormadi**.

| Ko'rsatkich | Qiymat |
|---|---|
| Umumiy oqim | ~30 xabar/soniya (~100 000/soat) — Telegram limiti |
| Bir vaqtda faol yozayotgan mijozlar | ~900 (har biri 30 soniyada 1 xabar) |
| Bitta operatorga | ~60 xabar/daqiqa (ko'pi navbatda kutadi, yo'qolmaydi) |
| Xabar yetib borish vaqti | ~0,4–1 soniya |
| Baza (Supabase Free, 500 MB) | ~1,2 million xabar; Pro (8 GB) ~20 million |

**Tavsiya:** Vercel **Hobby** rasman faqat notijorat foydalanish uchun — biznes uchun **Vercel Pro ($20/oy)**. Haqiqiy mijoz ma'lumotlari uchun **Supabase Pro ($25/oy)**: avtomatik backup, pauza yo'q, 250 GB trafik.
