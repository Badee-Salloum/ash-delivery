/**
 * Arabic catalog — the DEFAULT language. Every user-facing string in both front-ends resolves
 * through here. English is the secondary; `en.ts` must stay key-for-key identical (CI checks it).
 *
 * The BR1 cause codes come from the pure domain as machine codes; this is where they become
 * something a branch manager reads under time pressure.
 */
export const ar = {
  app: { title: 'ASH Delivery', tagline: 'منصة التوصيل والإدارة المالية' },

  roles: {
    general_manager: 'المدير العام',
    system_admin: 'مدير النظام',
    branch_manager: 'مدير الفرع',
    driver: 'سائق',
    accountant: 'محاسب',
  },

  accounts: {
    title: 'الحسابات',
    add: 'إضافة حساب',
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    fullName: 'الاسم الكامل',
    role: 'الدور',
    branch: 'الفرع',
    status: 'الحالة',
    active: 'نشط',
    inactive: 'متوقف',
    create: 'إنشاء الحساب',
    branchHint: 'مطلوب لمدير الفرع والسائق',
    created: 'تم إنشاء الحساب',
    duplicate: 'اسم المستخدم مستخدم مسبقاً',
    passwordHint: '٨ أحرف على الأقل',
    actions: 'إجراءات',
    edit: 'تعديل',
    save: 'حفظ',
    cancel: 'إلغاء',
    deactivate: 'تعطيل',
    activate: 'تفعيل',
    resetPassword: 'كلمة مرور جديدة',
    newPassword: 'كلمة المرور الجديدة',
    updated: 'تم تحديث الحساب',
  },

  permissions: {
    title: 'مصفوفة الصلاحيات',
    hint: 'التعديل هنا يسري فوراً على كل الطلبات — بدون إعادة نشر.',
    permission: 'الصلاحية',
    saved: 'تم الحفظ',
    lockoutRefused: 'مرفوض: يجب أن يبقى دور واحد على الأقل يملك إدارة المستخدمين.',
    emptyRefused: 'مرفوض: لا يمكن إفراغ المصفوفة بالكامل.',
    scopes: {
      own: 'الخاص به',
      branch: 'فرعه',
      all: 'الكل',
    },
  },

  audit: {
    title: 'سجل التدقيق',
    table: 'الجدول',
    record: 'السجل',
    action: 'العملية',
    actor: 'المستخدم',
    when: 'الوقت',
    search: 'بحث',
    details: 'التفاصيل',
  },

  common: {
    save: 'حفظ',
    cancel: 'إلغاء',
    confirm: 'تأكيد',
    submit: 'إرسال',
    approve: 'اعتماد',
    reject: 'رفض',
    retake: 'إعادة التصوير',
    loading: 'جارٍ التحميل…',
    today: 'اليوم',
    total: 'الإجمالي',
    difference: 'الفرق',
    logout: 'تسجيل الخروج',
    yes: 'نعم',
    no: 'لا',
    required: 'مطلوب',
    of: 'من',
  },

  auth: {
    username: 'اسم المستخدم',
    password: 'كلمة المرور',
    signIn: 'تسجيل الدخول',
    invalidCredentials: 'اسم المستخدم أو كلمة المرور غير صحيحة',
    locked: 'الحساب مقفل مؤقتاً بعد محاولات فاشلة',
    twoFactorTitle: 'رمز التحقق',
    twoFactorPrompt: 'أدخل الرمز من تطبيق المصادقة',
    enrollTitle: 'تفعيل المصادقة الثنائية',
    enrollPrompt: 'امسح الرمز بتطبيق المصادقة ثم أدخل الرمز الظاهر',
    badCode: 'الرمز غير صحيح',
  },

  shift: {
    myAssignment: 'إسنادي اليوم',
    vehicle: 'الآلية',
    shiftNo: 'رقم النوبة',
    startPackage: 'حزمة البداية',
    reading: 'جارٍ قراءة الصورة',
    busyVehicle: 'على نوبة الآن',
    assignedVehicle: 'الآلية المسندة إليك اليوم — أكّد للبدء',
    pickVehicle: 'اختر الآلية التي ستعمل عليها',
    noAssignment: 'لا توجد آلية مسندة إليك اليوم — راجع مدير الفرع',
    cannotStart: {
      vehicle_already_on_shift: 'هذه الآلية على نوبة أخرى الآن — اختر آلية غيرها.',
      driver_already_on_shift: 'لديك نوبة مفتوحة بالفعل.',
      vehicle_not_assigned: 'هذه الآلية ليست المسندة إليك اليوم.',
      vehicle_assigned_to_other_driver: 'هذه الآلية مسندة لسائق آخر اليوم.',
    },
    endPackage: 'حزمة النهاية',
    odometer: 'العداد',
    battery: 'البطارية',
    cashFloat: 'كاش التحرك',
    walletTopup: 'شحن المحفظة',
    cashHandover: 'النقد المسلَّم',
    walletBalance: 'رصيد المحفظة',
    walletZeroed: 'صورة المحفظة صفراً',
    dashboardShot: 'سكرينشوت الداشبورد',
    confirmStart: 'تأكيد وبدء النوبة',
    submitEnd: 'إرسال حزمة النهاية',
    states: {
      draft: 'مسودة',
      awaiting_open_approval: 'بانتظار اعتماد البداية',
      open: 'مفتوحة',
      pending_review: 'بانتظار المراجعة',
      approved: 'معتمدة',
      suspended: 'معلقة',
      week_locked: 'مقفلة أسبوعياً',
    },
  },

  orders: {
    title: 'الطلبات',
    orderNo: 'رقم الطلب',
    fee: 'الأجرة',
    payMode: 'نمط الدفع',
    addRow: 'إضافة طلب',
    count: 'عدد الطلبات',
    payModes: { cash: 'كاش', electronic: 'إلكتروني', free: 'مجاني' },
    problems: {
      empty_order_no: 'رقم الطلب مطلوب',
      duplicate_order_no: 'رقم طلب مكرر',
      bad_fee: 'أجرة غير صالحة',
      negative_fee: 'الأجرة لا يمكن أن تكون سالبة',
    },
  },

  br1: {
    title: 'المعادلة الصفرية',
    expectedCash: 'الكاش المتوقع',
    expectedWallet: 'المحفظة المتوقعة',
    balanced: 'المعادلة متوازنة ✓',
    notBalanced: 'المعادلة غير متوازنة',
    cause: {
      balanced: 'كل شيء متوازن',
      pay_mode_misclassified: 'نمط دفع خاطئ في أحد الطلبات',
      missing_order: 'طلب ناقص',
      extra_order: 'طلب زائد',
      unrecorded_float_tranche: 'دفعة كاش تحرك غير مسجلة',
      unrecorded_topup_tranche: 'دفعة شحن محفظة غير مسجلة',
      cash_handover_mismatch: 'فرق في النقد المسلَّم',
      wallet_reading_mismatch: 'فرق في قراءة المحفظة',
      unexplained: 'فرق غير مفسَّر',
    },
  },

  fleet: {
    drivers: 'السائقون',
    vehicles: 'الآليات',
    documents: 'الوثائق',
    expiring: 'وثائق قاربت على الانتهاء',
    addDriver: 'إضافة سائق',
    addVehicle: 'إضافة آلية',
    assignments: 'إسناد الآليات',
    assignVehicle: 'إسناد آلية لسائق',
    driver: 'السائق',
    assign: 'إسناد',
    unassign: 'إلغاء الإسناد',
    assigned: 'تم الإسناد',
    alreadyAssigned: 'السائق أو الآلية مسندة مسبقاً لهذا اليوم',
    noAssignments: 'لا إسنادات لهذا اليوم',
    date: 'التاريخ',
    releaseVehicle: 'تحرير الآلية',
    code: 'الرمز',
    name: 'الاسم',
    state: 'الحالة',
    vehicleStates: { ready: 'جاهزة', charging: 'تشحن', maintenance: 'صيانة', stopped: 'متوقفة' },
    docStatus: {
      valid: 'سارية',
      expiring_soon: 'قاربت على الانتهاء',
      expires_today: 'تنتهي اليوم',
      expired: 'منتهية',
      no_expiry: 'بلا انتهاء',
    },
    blocked: 'محظور بسبب وثيقة منتهية',
  },

  treasury: {
    cashCount: 'الجرد اليومي',
    branchTreasury: 'خزينة الفرع',
    cashBox: 'صندوق الكاش',
    wallet: 'المحفظة',
    deposit: 'إيداع',
    depositAmount: 'المبلغ',
    deposited: 'تم الإيداع',
    counted: 'المعدود',
    computed: 'المحسوب',
    variance: 'الفرق',
    sealProof: 'إثبات الجرد',
    manualEntry: 'قيد يدوي',
    reason: 'السبب',
    expenses: 'الصرفيات',
    category: 'الفئة',
    costCenter: 'مركز الكلفة',
    amount: 'المبلغ',
    receiptRequired: 'إيصال مطلوب لهذا المبلغ',
  },

  tiers: {
    title: 'شرائح الحصص',
    band: 'الشريحة',
    fromOrders: 'من (طلبات)',
    toOrders: 'إلى (طلبات)',
    driverShare: 'حصة السائق',
    effectiveFrom: 'ساري من',
    publish: 'نشر',
    simulate: 'محاكاة',
    simulateResult: 'أثر المحاكاة',
  },

  dashboard: {
    title: 'اللوحة',
    revenue: 'إيراد الأجور اليوم',
    orders: 'الطلبات',
    companyShare: 'حصة الشركة منذ الأحد',
    fleetReadiness: 'جاهزية الأسطول',
    completeness: 'اكتمال البيانات',
    openShifts: 'نوبات مفتوحة',
    awaitingApproval: 'بانتظار الاعتماد',
    totalProfit: 'الأرباح الإجمالية',
  },

  approval: {
    queue: 'قائمة الاعتماد',
    review: 'مراجعة النوبة',
    sideBySide: 'الصور والأرقام',
    startVsEnd: 'مقارنة عداد البداية والنهاية',
    approveClose: 'اعتماد الإنهاء',
    requestRetake: 'طلب إعادة تصوير',
    notes: 'ملاحظات',
  },

  week: {
    close: 'الإقفال الأسبوعي',
    closeSunday: 'إقفال الأحد',
    blockers: 'موانع الإقفال',
    sealed: 'تم إقفال الأسبوع',
  },
} as const

/**
 * The catalog SHAPE, with `string` leaves rather than the `as const` literals of `ar`.
 *
 * `en` must have the same keys (a missing or extra one is a compile error) but obviously not the
 * same *values* — so the type maps every leaf to `string`. `DeepStringify` walks the nested
 * objects, keeping the key structure and relaxing only the leaves.
 */
type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>
}
export type Catalog = DeepStringify<typeof ar>
