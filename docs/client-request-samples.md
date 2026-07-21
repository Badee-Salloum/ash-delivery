# Client request — the four samples and one ground-truth shift

**Status: DRAFT, NOT SENT.** I could not send this: the Gmail connector is not authorised in this
session. Authorise it via claude.ai connector settings (or send it yourself) — this is the single
highest-value hour in the project and everything downstream calibrates against the answer.

**Why this is urgent, not routine.** BR1's tolerance is zero, and the wallet figure it is measured
against is produced by **Yallago's** app, not ours. Our expected wallet comes from our model of what
Yallago does. If their number carries anything the model does not — tips, promotional credits,
cancellation reversals, a pending-vs-settled distinction, the goods value of an electronic order
(SRS open point م-3), or simply a different rounding direction on the 20% — then **every shift is
unclosable on day one**, which blocks the vehicle, the driver's next day, and the Sunday close.

The kickoff brief has these samples arriving "mid-development". That is where rework comes from.
One real shift, now, settles it.

---

## Subject

طلب عينات لبدء التطوير — منصة ASH Delivery / Sample data request to begin development

---

## Arabic (send this)

الأستاذ الكريم،

بدأنا العمل على منصة ASH Delivery وفق مواصفات SRS v1.0 المعتمدة. قبل أن نبني النواة المالية نحتاج
عينات حقيقية، لأن **معادلة النوبة الصفرية (BR1) تسامحها صفر**، وهي تُقارن رقماً يحسبه نظامنا برقم
يعرضه تطبيق يلاغو ولا نتحكم به. أي فرق في طريقة احتساب يلاغو — تقريب مختلف، إكرامية، رصيد ترويجي،
طلب ملغى بعد الدفع، أو وصول قيمة البضاعة إلى المحفظة في الطلب الإلكتروني — يجعل **كل النوبات غير
قابلة للإغلاق من اليوم الأول**.

**المطلوب الآن (الأهم على الإطلاق) — نوبة واحدة حقيقية موثّقة بالكامل:**

لنوبة واحدة فقط، في يوم واحد، لسائق واحد، نحتاج الأربعة معاً:

1. **سكرينشوت داشبورد يلاغو** لتلك النوبة بالذات (قائمة الطلبات: رقم الطلب، الأجرة، نمط الدفع).
2. **سكرينشوت رصيد محفظة السائق** في نهاية تلك النوبة نفسها.
3. **الأرقام التي عدّها مدير الفرع على الأرض** لنفس النوبة: كاش التحرك المُسلَّم، مبلغ شحن المحفظة،
   النقد المستلم من السائق في النهاية.
4. **قراءة العداد** بداية النوبة ونهايتها، إن توفّرت.

الأهم أن تكون الأربعة **لنفس النوبة**، لا لنوبات متفرقة — الغاية أن نطابق حساب النظام على واقعة
واحدة كاملة.

**عينات لاحقة (لا توقف العمل الآن):**

5. تقرير يلاغو الأسبوعي PDF — نموذج واحد (للحزمة الثانية).
6. ملف بطارية يومي لآلية واحدة (للحزمة الثالثة).
7. ملف الإكسل الحالي للصناديق والأرصدة الافتتاحية — **مطلوب قبل التشغيل الإنتاجي للقسم E**
   (النقطة المفتوحة م-2 في المواصفات).

**سؤال واحد يحتاج جواباً:** في الطلب الإلكتروني، هل تصل **قيمة البضاعة** إلى محفظة السائق مع
الأجرة، أم الأجرة فقط؟ (النقطة المفتوحة م-3). بنينا النظام بحيث لا يتوقف على الجواب — الافتراض
الحالي هو الأجرة فقط، وتغييره لاحقاً إعداد لا تعديل برمجي — لكن العينة في البند 1 ستحسمه نهائياً.

نرجو الأربعة الأولى خلال **[التاريخ]**. باقي البنود عند توفرها.

وتفضلوا بقبول فائق الاحترام،

---

## English (for your own file)

We have started ASH Delivery against the approved SRS v1.0. Before building the financial core we
need real samples, because **BR1's tolerance is zero** and it compares a number our system computes
against a number Yallago's app displays and we do not control.

**The critical ask — one real, fully documented shift.** For a single shift, single day, single
driver, all four together:

1. The Yallago dashboard screenshot for *that* shift (order no., fee, payment mode per order).
2. The driver's wallet balance screenshot at the end of *that same* shift.
3. The branch manager's counted ground truth for the same shift: cash float handed out, wallet
   top-up amount, cash received back at close.
4. Odometer readings at start and end, if available.

They must all belong to the **same shift** — the whole point is to reconcile our arithmetic against
one complete real event.

**Later, non-blocking:** a sample weekly Yallago PDF (Bundle 2), one daily battery file (Bundle 3),
and the current funds/opening-balances Excel — the last of which is **required before section E goes
live in production** (SRS open point م-2).

**Two questions:**

1. For an electronic order, does the **goods value** reach the driver's wallet along with the fee,
   or the fee only? (SRS م-3.) The build does not block on it — the current assumption is fee-only
   and flipping it is a setting, not a migration — but sample 1 settles it for good.
2. **What happens when Yallago's 20% cut exceeds the driver's wallet balance?** Does the app refuse
   the order, allow the wallet to go negative, or auto-settle? This is not hypothetical: every cash
   order takes 20% *out* of the wallet while putting nothing in, so twenty 5,000 cash orders on a
   1,000 top-up want 20,000 from a wallet holding 1,000. The zero equation still balances perfectly
   while it happens, so BR1 cannot catch it. The answer decides whether this blocks a shift close or
   just warns the branch manager.

---

## What changes depending on the answer

| Finding in the sample | Consequence |
| --- | --- |
| Yallago's 20% is rounded up, or to nearest | Change one argument: `yalagoCut(fee, 'ceil' \| 'half-up')`. Already parameterised — see `packages/domain/src/money/allocate.ts`. |
| Goods value reaches the wallet on electronic orders | Activate the goods legs; BR1 stays fee-only either way *provided* the value round-trips. |
| The wallet carries tips or promo credits | **Structural.** BR1 needs a reconciling term, and the pilot must run with `br1_split_gate = advisory` until it is modelled. |
| Wallet shows pending vs. settled separately | The end-package photo must capture the settled figure, and the driver instructions change. |
| Everything matches the model | Proceed to M2 with the gate strict from day one. |
