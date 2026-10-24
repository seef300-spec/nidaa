# واجهة التكامل (الكاشير لاحقًا)

المواصفة الكاملة بصيغة OpenAPI: `GET /api/v1/openapi.json`

## المصادقة
من **الإعدادات ← ربط الكاشير** أنشئ مفتاحًا (يظهر مرة واحدة). كل مفتاح مقيد بفرع واحد وبصلاحيات `orders:read` و/أو `orders:write`، ويمكن إلغاؤه فورًا.
```
Authorization: Bearer nd_ab12cd34_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## منع التكرار
- `externalId` (معرّف الطلب في الكاشير): إنشاء طلب بنفس المعرّف يعيد الطلب الموجود (`200` + `duplicate: true`) بدل إنشاء طلب جديد.
- ترويسة `Idempotency-Key` (8–100 حرف) على أي عملية تعديل: إعادة الإرسال بنفس المفتاح تعيد النتيجة الأولى (`Idempotent-Replayed: true`)؛ نفس المفتاح بمحتوى مختلف ← `422`.

## العمليات
| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/v1/orders` | إنشاء طلب `{ externalId, externalSource?, externalRef?, note?, showOnDisplay? }` ← يعيد `number` و `url` (لطباعته QR في إيصال الكاشير) |
| GET | `/api/v1/orders?externalId=…` | البحث بمعرّف الكاشير |
| GET | `/api/v1/orders/{id}` | قراءة طلب، يشمل حالة العميل والتنبيه |
| POST | `/api/v1/orders/{id}/ready` | جاهز + نداء العميل |
| POST | `/api/v1/orders/{id}/recall` | إعادة النداء (يحترم الفاصل ← `429` + `Retry-After`) |
| POST | `/api/v1/orders/{id}/deliver` | تم التسليم |
| POST | `/api/v1/orders/{id}/cancel` | إلغاء |

يمكن إرسال `{"expectedVersion": n}` لمنع التعارض (← `409 version_conflict` مع النسخة الحالية).

## الأخطاء
```json
{ "error": { "code": "invalid_transition", "message": "لا يمكن نداء طلب مُسلَّم" } }
```
`400` مدخلات، `401` مفتاح غير صالح، `403` صلاحية ناقصة، `404` غير موجود (أو لفرع آخر)، `409` انتقال غير مسموح/تعارض، `422` مفتاح عدم تكرار مستخدم لمحتوى مختلف، `429` تجاوز المعدل أو الفاصل.

## مثال
```bash
curl -X POST https://nidaa-xxxx.onrender.com/api/v1/orders \
  -H "Authorization: Bearer $NIDAA_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: pos-1001-create" \
  -d '{"externalId":"1001","externalRef":"1001"}'
```

## التوسعات المستقبلية (البنية جاهزة دون بنائها الآن)
- **عدة محلات وفروع**: جداول `tenants` و `branches` و `user_branches` قائمة، وكل استعلام مقيد بالفرع. إضافة محل: `node scripts/create-tenant.js`. إضافة فرع: `POST /api/owner/branches`.
- **منيو / ولاء / اشتراكات**: لم تُبنَ عمدًا. يمكن إضافتها كجداول مستقلة مرتبطة بـ `tenant_id` دون المساس بدورة الطلب.
