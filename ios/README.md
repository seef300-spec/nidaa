# App Clip «نداء»: إشعار وLive Activity للآيفون بدون تثبيت تطبيق

**الحالة: الكود جاهز ولم يُبنَ أو يُختبر على جهاز.** لا تتوفر بيئة ماك/Xcode هنا، فلم يُترجَم كود Swift ولم يُشغَّل. أما جهة الخادم (APNs وLive Activity وAASA) فهي منفّذة ومختبرة آليًا مقابل خادم APNs وهمي، يتحقق من الترويسات وتوقيع JWT.

## لماذا App Clip؟
عند مسح رمز QR في سفاري العادي، **لا يسمح iOS** بأي إشعار والجوال مقفل. أما App Clip فيعطي ما يلي:
- يفتح من **نفس رمز QR** دون تثبيت، وتظهر بطاقة في أسفل الشاشة.
- **إشعارات لمدة 8 ساعات دون نافذة إذن** (ephemeral)، ما لم يعطّلها العميل من البطاقة.
- **Live Activity**: رقم الطلب وحالته على شاشة القفل والجزيرة الديناميكية، وتتحول إلى «جاهز» عند النداء.

## الاعتمادات المطلوبة منك
1. **عضوية Apple Developer Program**: ‏99 دولارًا سنويًا، باسمك أو باسم منشأتك.
2. **جهاز ماك** عليه Xcode 16 أو أحدث، أو مطوّر iOS يملك ماك.
3. **نطاق خاص** للنظام (مثل `nidaa.yourcafe.com`). لا يمكن ربط App Clip بنطاق `onrender.com` لأنك لا تملكه.
4. **مراجعة App Store**: التطبيق الكامل الحاضن مطلوب من آبل لنشر App Clip. التطبيق الموجود هنا بسيط، وقد تطلب آبل محتوى أكثر.

## الخطوات
1. في developer.apple.com أنشئ ثلاثة معرّفات (Identifiers):
   - `com.yourco.nidaa` (التطبيق)،
   - `com.yourco.nidaa.Clip` (App Clip) مع تفعيل Push Notifications وAssociated Domains،
   - `com.yourco.nidaa.Clip.LiveActivity`.
2. **Keys ← +** ← فعّل «Apple Push Notifications service (APNs)» ← نزّل ملف `AuthKey_XXXX.p8`. **يُنزَّل مرة واحدة فقط، فاحفظه بأمان.**
3. على الماك:
   ```bash
   brew install xcodegen
   cd ios
   # عدّل في project.yml: DEVELOPMENT_TEAM و BUNDLE_PREFIX و NIDAA_DOMAIN
   xcodegen generate && open Nidaa.xcodeproj
   ```
   ابنِ التطبيق على آيفون حقيقي. لاختبار App Clip محليًا: Settings ← Developer ← Local Experiences، وأضف بادئة الرابط `https://nidaa.yourcafe.com/o/`.
4. في Render ← Environment أضف المتغيرات التالية:
   - `APNS_KEY_ID`: معرّف المفتاح (10 خانات)،
   - `APNS_TEAM_ID`: معرّف الفريق،
   - `APNS_PRIVATE_KEY`: محتوى ملف ‎.p8 كاملًا،
   - `APNS_BUNDLE_ID=com.yourco.nidaa.Clip`،
   - `APPLE_APP_ID=TEAMID.com.yourco.nidaa.Clip`،
   - `APPLE_STORE_APP_ID`: الرقم الرقمي للتطبيق بعد إنشائه في App Store Connect (اختياري، لبطاقة سفاري).

   تحقق بعدها أن `https://نطاقك/.well-known/apple-app-site-association` يعيد `{"appclips":{"apps":["TEAMID.com.yourco.nidaa.Clip"]}}`.
5. في App Store Connect: ارفع البناء، ثم أنشئ **Advanced App Clip Experience** ببادئة الرابط `https://نطاقك/o/`. هذا ضروري لأن كل طلب له رابط مختلف.
6. **اختبار القبول على جهاز حقيقي**، وسجّل النتيجة:
   - مسح الرمز ← تظهر بطاقة App Clip ← فتح ← رقم الطلب صحيح.
   - في اللوحة: «فتح الطلب» و«التنبيه مفعّل».
   - اقفل الجوال ← نادِ ← يصل إشعار + تتحول Live Activity إلى «جاهز».
   - في اللوحة: «قبلته خدمة الإشعارات»، و«✓ ظهر في صفحته» عند فتح الـ Clip.
   - سلّم الطلب ← تنتهي Live Activity خلال دقيقتين.
   - عطّل الإشعارات من بطاقة App Clip وكرر الاختبار ← يجب أن تعرض اللوحة الحالة الصحيحة.

## بنية الكود
- `Shared/NidaaOrderAttributes.swift`: حقول `content-state` مطابقة لما يرسله الخادم (`status` و`number` و`message` و`calledAt`).
- `Shared/NidaaAPI.swift`: الواجهة العامة نفسها التي تستخدمها صفحة الويب، بصلاحية الرابط فقط.
- `NidaaClip/`: الواجهة، وتسجيل APNs، وطلب Live Activity بنوع `pushType: .token` مع إرسال الرمز للخادم.
- `NidaaLiveActivity/`: ملحق يحتوي Live Activity فقط، كما تشترط آبل لملحقات App Clip.
- جهة الخادم: `src/services/notify/apns.js` و`src/services/notify/index.js`.
