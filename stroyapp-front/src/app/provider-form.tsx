import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, StyleSheet, Text, View, type TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, dictsApi, providersApi, subscriptionApi } from '@/api';
import type { OwnerProviderFull, ProviderBody } from '@/api';
import type {
  Category,
  City,
  ListingKind,
  PriceItem,
  PriceUnit,
  ProviderAttrType,
  ProviderVerification,
  SellerPlan,
} from '@/api/types';
import { Button } from '@/components/Button';
import { Card, RowGroup, SectionLabel, SwitchRow } from '@/components/Card';
import { Chip, ChipWrap } from '@/components/Chip';
import { CityPicker } from '@/components/CityPicker';
import { Badge, ErrorBanner, Loader, useAnnounce } from '@/components/Feedback';
import { Field, Input, SelectField } from '@/components/Field';
import { PhotoStrip } from '@/components/PhotoStrip';
import { PhotoViewer } from '@/components/PhotoViewer';
import { Screen } from '@/components/Screen';
import { Segment } from '@/components/Segment';
import { Sheet } from '@/components/Sheet';
import { space, text, type ThemeColors } from '@/theme';
import { useThemedStyles } from '@/theme/scheme';
import { confirmDestructive, showThen } from '@/utils/alert';
import { KIND_KEY, KINDS } from '@/utils/category';
import { parseCoord, splitCoordPaste } from '@/utils/coords';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { pushOnce, useOnTop } from '@/utils/nav';
import { intOrNull, onlyDigits } from '@/utils/number';
import { photoUrl } from '@/utils/photo';
import { pickPhotos, type PickedPhoto } from '@/utils/pickPhotos';
import { UNITS, unitName } from '@/utils/priceUnit';

/** Единица по умолчанию: материалы чаще продают штуками, работы — за м². */
const DEFAULT_UNIT: Record<ListingKind, PriceUnit> = { material: 'piece', service: 'm2' };

/** Столько фото на карточку принимает сервер; лишние он отклоняет всей пачкой. */
const PHOTO_LIMIT = 20;

// Пределы сервера (r23_providers.py). Длиннее он отклонит — лучше не дать
// набрать, чем вернуть ошибку после «Сохранить».
const NAME_MAX = 200;
const DESCRIPTION_MAX = 5000;
const PHONE_MAX = 20;
const ADDRESS_MAX = 500;
const ITEM_NAME_MAX = 300;
/** Столько позиций в прайсе принимает сервер при любом тарифе (ITEMS_LIMIT). */
const ITEMS_LIMIT = 500;
/** БИН компании или ИИН предпринимателя — 12 цифр. */
const BIN_DIGITS = 12;
/** Девять цифр — это до 999 999 999 ₸; сервер принимает цену до миллиарда. */
const PRICE_DIGITS = 9;

type FieldKey = 'category' | 'city' | 'name' | 'items' | 'lat' | 'lng';
type FieldErrors = Partial<Record<FieldKey, string>>;

/** Порядок полей на экране: в полосе у кнопки показываем ошибку верхнего. */
const FIELD_ORDER: FieldKey[] = ['category', 'city', 'name', 'items', 'lat', 'lng'];

/** Строка прайса в форме: цена — текстом, как в поле ввода. */
interface ItemDraft {
  key: string;
  name: string;
  unit: PriceUnit;
  price: string;
}

/** Чью единицу выбирают в шторке: «цена от» или строки прайса. */
type UnitTarget = { kind: 'from' } | { kind: 'item'; key: string };

/** Фото, выбранное на телефоне и ещё не отправленное на сервер. */
interface PendingPhoto extends PickedPhoto {
  key: string;
}

/**
 * Объявление магазина или бригады: создание, правка, прайс, фото и удаление.
 *
 * Фото и прайс можно заполнить ещё до первого сохранения:
 * они копятся на телефоне и уходят на сервер сразу после того, как сама
 * карточка создана или изменена. Человек заполняет всё за один проход, а не
 * сохраняет пустую карточку, чтобы потом вернуться за фотографиями.
 *
 * Справочники и карточка грузятся один раз при открытии, а не на каждый
 * фокус: повторная загрузка стёрла бы то, что человек уже набрал.
 */
export default function ProviderFormScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ providerGuid?: string; categoryId?: string }>();
  const editingGuid = params.providerGuid || undefined;
  // Категория, выбранная в списке добавления, — подставляется в новую
  // карточку. Параметры приходят строками; нечисло просто не подставляем.
  const presetNumber = params.categoryId ? Number(params.categoryId) : NaN;
  const presetCategoryId = Number.isNaN(presetNumber) ? null : presetNumber;

  const [categories, setCategories] = useState<Category[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [attrTypes, setAttrTypes] = useState<ProviderAttrType[]>([]);
  /** Карточка, как она лежит на сервере; null — ещё не создана. */
  const [provider, setProvider] = useState<OwnerProviderFull | null>(null);
  /** Тариф владельца: сколько позиций прайса видно клиентам. null — не узнали. */
  const [plan, setPlan] = useState<SellerPlan | null>(null);

  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [city, setCity] = useState<City | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  // Вид выбирают раньше категории: категорий двух видов вместе слишком много.
  const [kind, setKind] = useState<ListingKind>('material');
  const [priceFrom, setPriceFrom] = useState('');
  const [priceUnit, setPriceUnit] = useState<PriceUnit>(DEFAULT_UNIT.material);
  const [items, setItems] = useState<ItemDraft[]>([]);
  // Прайс уходит отдельным запросом и целиком: шлём, только если его меняли.
  const [itemsDirty, setItemsDirty] = useState(false);
  const [unitTarget, setUnitTarget] = useState<UnitTarget | null>(null);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [attrIds, setAttrIds] = useState<number[]>([]);
  const [isActive, setIsActive] = useState(true);

  const [pendingPhotos, setPendingPhotos] = useState<PendingPhoto[]>([]);
  /** С какого фото открыт просмотр; null — закрыт. */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const [cityOpen, setCityOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Сохранено, экран закрывается: форма доживает под сообщением об успехе. */
  const [done, setDone] = useState(false);
  /** Ответ сервера или сбой с фото; ошибки полей лежат отдельно, в errors. */
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const nameRef = useRef<TextInput>(null);
  const latRef = useRef<TextInput>(null);
  const lngRef = useRef<TextInput>(null);

  // Категории переключают быстрее, чем отвечает сервер: показываем атрибуты
  // только последнего запроса, иначе к новой категории приедут чужие.
  const attrRequest = useRef(0);

  const loadAttrTypes = useCallback(async (code: string) => {
    const request = ++attrRequest.current;
    try {
      const res = await dictsApi.providerAttrTypes(code);
      if (request !== attrRequest.current) return;
      setAttrTypes(res.items);
      // Отмеченное, чего в справочнике категории уже нет, сервер отклонил бы
      // вместе со всей карточкой.
      setAttrIds((prev) => prev.filter((id) => res.items.some((a) => a.id === id)));
    } catch {
      // Без справочника блока «Специализация» просто нет: карточку можно
      // сохранить и без него, а уже отмеченное на сервере остаётся как было.
      if (request === attrRequest.current) setAttrTypes([]);
    }
  }, []);

  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [cats, cityList, found, sub] = await Promise.all([
        dictsApi.categories(),
        dictsApi.cities(),
        editingGuid ? providersApi.get(editingGuid) : Promise.resolve(null),
        // Тариф — только подсказка у прайса: без него форма работает.
        subscriptionApi.get().catch(() => null),
      ]);
      if (request !== loadRequest.current) return;
      setPlan(sub?.plan ?? null);

      const selectable = cats.items;
      setCategories(selectable);
      setCities(cityList.items);

      let startCategoryId: number | null = null;
      if (found) {
        const v = found.provider;
        setProvider(v);
        setCity(cityList.items.find((c) => c.id === v.city_id) ?? null);
        setName(v.name);
        setDescription(v.description ?? '');
        setPhone(v.phone ?? '');
        setAddress(v.address ?? '');
        setPriceFrom(v.price_from != null ? String(v.price_from) : '');
        const vKind = selectable.find((c) => c.id === v.category_id)?.kind ?? 'material';
        setKind(vKind);
        setPriceUnit(v.price_unit ?? DEFAULT_UNIT[vKind]);
        setItems(v.items.map(toDraft));
        setItemsDirty(false);
        setLat(v.latitude != null ? String(v.latitude) : '');
        setLng(v.longitude != null ? String(v.longitude) : '');
        setAttrIds(v.attrs.map((a) => a.id));
        setIsActive(v.is_active);
        startCategoryId = v.category_id;
      } else {
        const preset = selectable.find((c) => c.id === presetCategoryId);
        if (preset) {
          startCategoryId = preset.id;
          setKind(preset.kind);
          setPriceUnit(DEFAULT_UNIT[preset.kind]);
        }
      }
      setCategoryId(startCategoryId);

      // Атрибуты не ждём: форма открывается сразу, блок «Специализация»
      // встаёт на место, когда доедет справочник.
      const startCategory = selectable.find((c) => c.id === startCategoryId);
      if (startCategory) void loadAttrTypes(startCategory.code);
    } catch (e) {
      if (request !== loadRequest.current) return;
      setLoadError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [editingGuid, presetCategoryId, loadAttrTypes, t]);

  // Что уже загружено. Без отметки смена языка (новая t) перезапустила бы
  // загрузку и затёрла набранное значениями с сервера.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${editingGuid ?? ''}:${presetCategoryId ?? ''}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    void load();
  }, [editingGuid, presetCategoryId, load]);

  // Сверху ли ещё форма. Человек может уйти назад, не дождавшись ответа, или
  // поверх откроется другой экран, а router действует на тот экран, что
  // сейчас сверху: «ОК» в сообщении об успехе закрыл бы уже не форму.
  const onTop = useOnTop();

  const clearErrors = (...keys: FieldKey[]) =>
    setErrors((prev) => {
      if (!keys.some((key) => prev[key])) return prev;
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });

  const selectCategory = (cat: Category) => {
    clearErrors('category');
    if (cat.id !== categoryId) {
      setCategoryId(cat.id);
      // Атрибуты у каждой категории свои: прежний список и отметки в нём к
      // новой не относятся, и сервер отклонил бы карточку с чужими.
      setAttrTypes([]);
      setAttrIds([]);
    } else if (attrTypes.length > 0) {
      return;
    }
    // Повторное нажатие на ту же категорию без атрибутов — способ дозагрузить
    // справочник, если в первый раз он не доехал.
    void loadAttrTypes(cat.code);
  };

  const selectKind = (next: ListingKind) => {
    if (next === kind) return;
    setKind(next);
    // Категория другого вида к новому не подходит, а с ней и её атрибуты.
    const current = categories.find((c) => c.id === categoryId);
    if (current && current.kind !== next) {
      setCategoryId(null);
      setAttrTypes([]);
      setAttrIds([]);
    }
  };

  const itemSeq = useRef(0);

  const addItem = () => {
    if (items.length >= ITEMS_LIMIT) {
      setError(t('owner.items_limit', { limit: ITEMS_LIMIT }));
      return;
    }
    // Единица — как у прошлой строки: прайс обычно идёт одним родом товара.
    const unit = items[items.length - 1]?.unit ?? DEFAULT_UNIT[kind];
    setItems((prev) => [...prev, { key: `n-${++itemSeq.current}`, name: '', unit, price: '' }]);
    setItemsDirty(true);
  };

  const changeItem = (key: string, patch: Partial<ItemDraft>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
    setItemsDirty(true);
    clearErrors('items');
  };

  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
    setItemsDirty(true);
    clearErrors('items');
  };

  const pickUnit = (unit: PriceUnit) => {
    if (unitTarget?.kind === 'from') setPriceUnit(unit);
    else if (unitTarget?.kind === 'item') changeItem(unitTarget.key, { unit });
    setUnitTarget(null);
  };

  const toggleAttr = (id: number) =>
    setAttrIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const onCoordChange = (field: 'lat' | 'lng', raw: string) => {
    const next = splitCoordPaste(field === 'lat' ? lat : lng, raw);
    if (typeof next !== 'string') {
      // Вставили пару целиком — раскладываем по обоим полям.
      setLat(next.lat);
      setLng(next.lng);
    } else if (field === 'lat') setLat(next);
    else setLng(next);
    // Обе сразу: ошибка «нужны обе координаты» висит на пустом поле, а
    // исправить её можно и стерев соседнее.
    clearErrors('lat', 'lng');
  };

  /**
   * Подводит человека к первой ошибке. Кнопка «Сохранить» закреплена внизу,
   * а поле с ошибкой может быть прокручено за край. Категория — не поле
   * ввода и стоит в самом верху: о ней говорит полоса над кнопкой.
   */
  const showFirstError = (found: FieldErrors) => {
    if (found.category) {
      Keyboard.dismiss();
    } else if (found.city) {
      Keyboard.dismiss();
      // Без справочника шторка открылась бы с «Город не найден».
      if (cities.length > 0) setCityOpen(true);
    } else if (found.name) nameRef.current?.focus();
    else if (found.lat) latRef.current?.focus();
    else if (found.lng) lngRef.current?.focus();
  };

  // Замок, а не только состояние: два быстрых нажатия успевают пройти до
  // перерисовки кнопки, и у новой карточки это были бы две одинаковые.
  const saveLock = useRef(false);

  const submit = async () => {
    if (saveLock.current) return;

    const latitude = parseCoord(lat, 90);
    const longitude = parseCoord(lng, 180);

    const found: FieldErrors = {};
    if (!categoryId) found.category = t('owner.provider_category_required');
    if (!city) found.city = t('owner.provider_city_required');
    if (!name.trim()) found.name = t('owner.provider_name_required');
    // Совсем пустые строки просто отбрасываем, а цена без названия — ошибка:
    // молча выбросить набранную цену было бы хуже.
    const filledItems = items.filter((it) => it.name.trim() || it.price);
    if (filledItems.some((it) => !it.name.trim())) found.items = t('owner.item_name_required');
    if (latitude === undefined) found.lat = t('owner.latitude_invalid');
    if (longitude === undefined) found.lng = t('owner.longitude_invalid');
    // Одна координата без другой бесполезна: маршрут в 2GIS строится только
    // по паре, и кнопки «Открыть в 2GIS» у такой карточки не было бы.
    const bothParsed = latitude !== undefined && longitude !== undefined;
    if (bothParsed && (latitude === null) !== (longitude === null)) {
      found[latitude === null ? 'lat' : 'lng'] = t('owner.coordinates_both_required');
    }

    if (!categoryId || !city || Object.keys(found).length > 0) {
      setErrors(found);
      setError(null);
      showFirstError(found);
      return;
    }

    const descriptionText = description.trim();
    const phoneText = phone.trim();
    const addressText = address.trim();
    const priceItems: PriceItem[] = filledItems.map((it) => ({
      name: it.name.trim(),
      unit: it.unit,
      price: intOrNull(it.price),
    }));
    const body: ProviderBody = {
      category_id: categoryId,
      city_id: city.id,
      name: name.trim(),
      description: descriptionText || null,
      phone: phoneText || null,
      address: addressText || null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      price_from: intOrNull(priceFrom),
      price_unit: priceUnit,
      attr_ids: attrIds,
    };

    saveLock.current = true;
    Keyboard.dismiss();
    setSaving(true);
    setError(null);
    setErrors({});

    const fail = (message: string) => {
      setError(message);
      setSaving(false);
      setUploading(false);
      saveLock.current = false;
    };

    // 1) Сама карточка. По карточке, а не по параметру экрана: если она уже
    // создана, а фото в прошлый раз не доехали, повторное «Сохранить» должно
    // править её, а не заводить вторую такую же.
    let saved: OwnerProviderFull;
    try {
      if (provider) {
        const res = await providersApi.patch(provider.guid, {
          ...body,
          // При правке null для сервера значит «не менять», и стёртые описание
          // и телефон возвращались бы после сохранения. Пустая строка их
          // стирает; шлём её, только когда стирать есть что.
          description: descriptionText || (provider.description ? '' : null),
          phone: phoneText || (provider.phone ? '' : null),
          address: addressText || (provider.address ? '' : null),
          is_active: isActive,
        });
        saved = res.provider;
      } else {
        const res = await providersApi.create(body);
        saved = res.provider;
      }
    } catch (e) {
      fail(e instanceof ApiError ? e.message : t('common.error_generic'));
      return;
    }
    setProvider(saved);
    setIsActive(saved.is_active);

    // 2) Прайс. У новой карточки — если в нём что-то есть, у старой — если
    // его меняли: иначе каждое сохранение переписывало бы его заново.
    if (itemsDirty || (!provider && priceItems.length > 0)) {
      try {
        const res = await providersApi.saveItems(saved.guid, priceItems);
        setItems(res.items.map(toDraft));
        setItemsDirty(false);
        setProvider((prev) => (prev ? { ...prev, items: res.items } : prev));
      } catch (e) {
        // Карточка уже сохранена — говорим об этом прямо.
        const reason = e instanceof ApiError ? `\n${e.message}` : '';
        fail(`${t('owner.items_save_failed')}${reason}`);
        return;
      }
    }

    // 3) Фото, выбранные до сохранения.
    if (pendingPhotos.length > 0) {
      setUploading(true);
      try {
        const res = await providersApi.uploadPhotos(
          saved.guid,
          pendingPhotos.map(({ uri, name: fileName, type }) => ({ uri, name: fileName, type })),
        );
        // От текущего состояния: пока шла загрузка, мог завершиться запрос на
        // удаление фото, и карточка из ответа выше вернула бы его в ленту.
        setProvider((prev) => {
          const base = prev ?? saved;
          const have = new Set(base.photos.map((p) => p.id));
          return { ...base, photos: [...base.photos, ...res.items.filter((p) => !have.has(p.id))] };
        });
        setPendingPhotos([]);
      } catch (e) {
        // Карточка уже сохранена — говорим об этом прямо, иначе по одной
        // ошибке сервера человек решит, что пропало всё набранное.
        const reason = e instanceof ApiError ? `\n${e.message}` : '';
        fail(`${t('owner.photos_upload_failed')}${reason}`);
        return;
      }
      setUploading(false);
    }

    // 4) Успех. Форму закрыли или накрыли другим экраном, пока шёл запрос:
    // «Сохранено» поверх чужого экрана ни к чему, а «назад» закрыл бы его.
    // Просто отпускаем кнопку, чтобы после возврата форма не крутила вертушку
    // без конца. Повторное «Сохранить» безопасно: карточка уже есть, и оно
    // её правит, а не заводит вторую.
    if (!onTop.current) {
      saveLock.current = false;
      setSaving(false);
      return;
    }
    // Замок не снимаем: экран закрывается, и повторное сохранение с него не
    // нужно.
    setSaving(false);
    setDone(true);
    // Возвращаться некуда, если форму открыли ссылкой, — тогда к списку.
    showThen(t('common.saved'), undefined, () => {
      if (!onTop.current) return;
      if (router.canGoBack()) router.back();
      else router.replace('/my-listings');
    });
  };

  const serverCount = provider?.photos.length ?? 0;

  // Плитка «добавить» не гаснет, пока открыта галерея: второе нажатие
  // открыло бы её дважды.
  const pickLock = useRef(false);
  // Счётчик, а не адрес файла: одно и то же фото можно выбрать дважды, и
  // ключи в ленте совпали бы.
  const pendingSeq = useRef(0);

  const addPhotos = async () => {
    if (pickLock.current) return;
    const room = PHOTO_LIMIT - serverCount - pendingPhotos.length;
    if (room <= 0) {
      setError(t('owner.photos_limit', { limit: PHOTO_LIMIT }));
      return;
    }

    pickLock.current = true;
    setError(null);
    try {
      const files = await pickPhotos(room);
      if (!files) return;
      const picked = files.map((file): PendingPhoto => ({ ...file, key: `p-${++pendingSeq.current}` }));
      setPendingPhotos((prev) => [...prev, ...picked]);
    } catch {
      setError(t('common.error_generic'));
    } finally {
      pickLock.current = false;
    }
  };

  // Фото, которые уже удаляются. Плитка на время запроса не меняется, и
  // второе нажатие на тот же крестик отправило бы второй запрос — сервер
  // ответил бы на него «Фото не найдено» поверх успешного удаления.
  const removingPhotos = useRef(new Set<number>());
  // Копия размера набора для кнопки «Сохранить»: изменение ref экран не
  // перерисует. Пока удаление идёт, сохранять нельзя — успех закрывает
  // форму, и сбой удаления было бы негде показать, а фото осталось бы в
  // объявлении, хотя человек считает его удалённым.
  const [removingCount, setRemovingCount] = useState(0);

  const deleteServerPhoto = (photoId: number) => {
    if (removingPhotos.current.has(photoId)) return;
    confirmDestructive(t('owner.delete_photo_title'), undefined, async () => {
      if (removingPhotos.current.has(photoId)) return;
      removingPhotos.current.add(photoId);
      setRemovingCount(removingPhotos.current.size);
      setError(null);
      try {
        await providersApi.deletePhoto(photoId);
        setProvider((prev) =>
          prev ? { ...prev, photos: prev.photos.filter((p) => p.id !== photoId) } : prev,
        );
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      } finally {
        removingPhotos.current.delete(photoId);
        setRemovingCount(removingPhotos.current.size);
      }
    });
  };

  // Лента и просмотр строятся из одного списка: номер плитки в ленте должен
  // совпадать с номером фото в просмотре.
  const photos = useMemo(() => {
    const list: { key: string; uri: string; full: string; pending?: boolean; id?: number }[] = [];
    for (const p of provider?.photos ?? []) {
      const full = photoUrl(p.file_path);
      const thumb = photoUrl(p.thumb_path) ?? full;
      if (thumb) list.push({ key: `s-${p.id}`, uri: thumb, full: full ?? thumb, id: p.id });
    }
    for (const p of pendingPhotos) {
      list.push({ key: p.key, uri: p.uri, full: p.uri, pending: true });
    }
    return list;
  }, [provider?.photos, pendingPhotos]);
  const fullUris = useMemo(() => photos.map((p) => p.full), [photos]);

  const removePhoto = (key: string) => {
    const photo = photos.find((p) => p.key === key);
    if (!photo) return;
    // Фото с сервера удаляется насовсем — спрашиваем. Невыгруженное просто
    // убираем из очереди: его в любой момент можно выбрать заново.
    if (photo.id != null) deleteServerPhoto(photo.id);
    else setPendingPhotos((prev) => prev.filter((p) => p.key !== key));
  };

  const remove = () => {
    if (!provider || saveLock.current) return;
    const guid = provider.guid;
    const doRemove = async () => {
      setError(null);
      setDeleting(true);
      try {
        await providersApi.remove(guid);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('common.error_generic'));
        setDeleting(false);
        return;
      }
      // Форму накрыли другим экраном: router увёл бы уже его. Карточки нет —
      // гасим форму, уйти с неё можно кнопкой «Назад» в шапке.
      if (!onTop.current) {
        setDeleting(false);
        setDone(true);
        return;
      }
      // Именно к списку, а не просто назад: форму могли открыть и не из
      // него, а удалённой карточке больше нигде нет места.
      router.dismissTo('/my-listings');
    };
    confirmDestructive(
      t('owner.delete_provider_confirm_title'),
      t('owner.delete_provider_confirm_text'),
      () => void doRemove(),
    );
  };

  // По карточке, а не только по параметру: после первого сохранения форма
  // уже правит созданную карточку, хотя открыта была как новая. По
  // параметру — чтобы заголовок правки стоял с первого кадра, пока грузится.
  const isEdit = !!provider || !!editingGuid;
  const title = t(isEdit ? 'owner.provider_form_edit' : 'owner.provider_form_new');
  const header = <Stack.Screen options={{ headerShown: true, title }} />;

  if (loading) {
    return (
      <Screen>
        {header}
        <Loader />
      </Screen>
    );
  }

  // Пустую форму поверх ошибки не показываем: без справочника категорий её
  // не сохранить, а при правке сохранение завело бы вторую карточку вместо
  // изменения этой.
  if (loadError) {
    return (
      <Screen scroll>
        {header}
        <ErrorBanner message={loadError} />
        <Button label={t('common.retry')} variant="outline" onPress={() => void load()} />
      </Screen>
    );
  }

  // Ошибка у кнопки, а не вверху формы: форма длиннее экрана, кнопка
  // закреплена внизу, и полосу над первым полем после нажатия не видно.
  const fieldError = FIELD_ORDER.map((key) => errors[key]).find(Boolean) ?? null;
  const busy = saving || deleting || done;

  return (
    <Screen
      scroll
      footer={
        <View style={styles.footer}>
          {/* Ошибку поля диктору уже проговорили её Field или подпись под
              чипами — полоса лишь показывает её зрячим и второй раз не
              объявляет. */}
          <ErrorBanner message={error ?? fieldError} announce={!!error} />
          <Button
            label={t('common.save')}
            onPress={submit}
            busy={saving}
            disabled={deleting || done || removingCount > 0}
          />
        </View>
      }
    >
      {header}

      <Segment
        value={kind}
        options={KINDS.map((k) => ({ value: k, label: t(KIND_KEY[k]) }))}
        onChange={selectKind}
      />

      <SectionLabel>{t('owner.provider_category_label')}</SectionLabel>
      <View style={styles.chipsBlock}>
        <ChipWrap>
          {categories.filter((cat) => cat.kind === kind).map((cat) => (
            <Chip
              key={cat.id}
              label={dictName(cat, lang)}
              selected={categoryId === cat.id}
              onPress={() => selectCategory(cat)}
            />
          ))}
        </ChipWrap>
        <FieldErrorText message={errors.category} />
      </View>

      <Card>
        <Field label={t('owner.venue_city_label')} error={errors.city}>
          <SelectField
            value={city ? dictName(city, lang) : null}
            placeholder={t('owner.venue_city_placeholder')}
            onPress={() => {
              Keyboard.dismiss();
              setCityOpen(true);
            }}
            invalid={!!errors.city}
          />
        </Field>

        <Field label={t('owner.provider_name_label')} error={errors.name}>
          <Input
            ref={nameRef}
            value={name}
            onChangeText={(value) => {
              setName(value);
              clearErrors('name');
            }}
            placeholder={t('owner.provider_name_placeholder')}
            accessibilityLabel={t('owner.provider_name_label')}
            maxLength={NAME_MAX}
            invalid={!!errors.name}
          />
        </Field>

        <Field label={t('owner.provider_description_label')}>
          <Input
            value={description}
            onChangeText={setDescription}
            placeholder={t('owner.provider_description_placeholder')}
            accessibilityLabel={t('owner.provider_description_label')}
            maxLength={DESCRIPTION_MAX}
            multiline
          />
        </Field>

        <Field label={t('owner.provider_address_label')}>
          <Input
            value={address}
            onChangeText={setAddress}
            placeholder={t('owner.provider_address_placeholder')}
            accessibilityLabel={t('owner.provider_address_label')}
            maxLength={ADDRESS_MAX}
          />
        </Field>

        {/* Телефон — как введён, без маски мобильного: у магазина бывает
            городской номер, а сервер хранит строку как есть. */}
        <Field label={t('owner.provider_phone_label')}>
          <Input
            value={phone}
            onChangeText={setPhone}
            placeholder={t('owner.venue_phone_placeholder')}
            accessibilityLabel={t('owner.provider_phone_label')}
            maxLength={PHONE_MAX}
            keyboardType="phone-pad"
          />
        </Field>
      </Card>

      <Card>
        {/* Пустая цена допустима: карточка покажет «Цена договорная». */}
        <Field label={t('owner.provider_price_label')}>
          <Input
            value={priceFrom}
            onChangeText={(value) => setPriceFrom(onlyDigits(value, PRICE_DIGITS))}
            placeholder="50000"
            accessibilityLabel={t('owner.provider_price_label')}
            keyboardType="number-pad"
          />
        </Field>

        <Field label={t('owner.provider_price_unit_label')}>
          <SelectField
            value={unitName(t, priceUnit)}
            placeholder={t('owner.unit_placeholder')}
            onPress={() => {
              Keyboard.dismiss();
              setUnitTarget({ kind: 'from' });
            }}
          />
        </Field>
      </Card>

      <SectionLabel>{t('owner.items_label')}</SectionLabel>
      <Text style={styles.sectionHint}>
        {kind === 'material' ? t('owner.items_hint_material') : t('owner.items_hint_service')}
      </Text>
      {items.map((item, index) => (
        <Card key={item.key}>
          <Field label={t('owner.item_name_label', { n: index + 1 })}>
            <Input
              value={item.name}
              onChangeText={(value) => changeItem(item.key, { name: value })}
              placeholder={
                kind === 'material'
                  ? t('owner.item_name_placeholder_material')
                  : t('owner.item_name_placeholder_service')
              }
              accessibilityLabel={t('owner.item_name_label', { n: index + 1 })}
              maxLength={ITEM_NAME_MAX}
              invalid={!!errors.items && !item.name.trim() && !!item.price}
            />
          </Field>
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field label={t('owner.item_price_label')}>
                <Input
                  value={item.price}
                  onChangeText={(value) => changeItem(item.key, { price: onlyDigits(value, PRICE_DIGITS) })}
                  placeholder={t('owner.item_price_placeholder')}
                  accessibilityLabel={t('owner.item_price_label')}
                  keyboardType="number-pad"
                />
              </Field>
            </View>
            <View style={styles.half}>
              <Field label={t('owner.item_unit_label')}>
                <SelectField
                  value={unitName(t, item.unit)}
                  placeholder={t('owner.unit_placeholder')}
                  onPress={() => {
                    Keyboard.dismiss();
                    setUnitTarget({ kind: 'item', key: item.key });
                  }}
                />
              </Field>
            </View>
          </View>
          <Button
            label={t('owner.item_remove')}
            variant="text"
            tone="danger"
            small
            onPress={() => removeItem(item.key)}
          />
        </Card>
      ))}
      {/* Сверх лимита тарифа позиции хранятся, но клиенты их не видят:
          продавец должен узнать об этом здесь, а не от покупателей. */}
      {plan && items.length > plan.items_limit ? (
        <Card style={styles.planHint}>
          <Text style={styles.planHintText}>
            {t('owner.items_hidden_by_plan', { count: plan.items_limit })}
          </Text>
          <Button
            label={t('subscription.open')}
            variant="outline"
            small
            onPress={() => pushOnce('/subscription')}
          />
        </Card>
      ) : null}
      {errors.items ? <FieldErrorText message={errors.items} /> : null}
      <Button
        label={t('owner.item_add')}
        variant="outline"
        icon="plus"
        onPress={addItem}
        disabled={busy}
      />

      {attrTypes.length > 0 ? (
        <>
          <SectionLabel>{t('provider.attrs_label')}</SectionLabel>
          <ChipWrap>
            {attrTypes.map((attr) => (
              <Chip
                key={attr.id}
                label={dictName(attr, lang)}
                selected={attrIds.includes(attr.id)}
                onPress={() => toggleAttr(attr.id)}
              />
            ))}
          </ChipWrap>
        </>
      ) : null}

      <Card>
        <Field
          label={t('owner.coordinates_label')}
          hint={t('owner.provider_coordinates_hint')}
          error={errors.lat ?? errors.lng}
        >
          <View style={styles.pair}>
            <Input
              ref={latRef}
              value={lat}
              onChangeText={(value) => onCoordChange('lat', value)}
              placeholder={t('owner.latitude')}
              // У пары полей подпись одна на двоих — диктору называем каждое.
              accessibilityLabel={t('owner.latitude')}
              // Не цифровая: на ней нет минуса и запятой.
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              invalid={!!errors.lat}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => lngRef.current?.focus()}
              style={styles.half}
            />
            <Input
              ref={lngRef}
              value={lng}
              onChangeText={(value) => onCoordChange('lng', value)}
              placeholder={t('owner.longitude')}
              accessibilityLabel={t('owner.longitude')}
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              invalid={!!errors.lng}
              returnKeyType="done"
              style={styles.half}
            />
          </View>
        </Field>
      </Card>

      {/* Новую карточку сервер создаёт опубликованной, снять с публикации
          можно только существующую — до сохранения переключатель был бы
          пустышкой. */}
      {provider ? (
        <RowGroup>
          <SwitchRow
            first
            label={t('owner.provider_is_active_label')}
            value={isActive}
            onValueChange={setIsActive}
            disabled={busy}
          />
        </RowGroup>
      ) : null}

      {/* У бригады фото — это её работы: так их и просим. */}
      <SectionLabel>
        {kind === 'service' ? t('owner.photos_works_label') : t('owner.provider_photos_label')}
      </SectionLabel>
      <Card>
        <PhotoStrip
          photos={photos}
          limit={PHOTO_LIMIT}
          onAdd={addPhotos}
          onRemove={removePhoto}
          onOpen={setViewerIndex}
          busy={uploading}
          disabled={busy}
          hint={
            uploading
              ? t('owner.photos_uploading')
              : pendingPhotos.length > 0
                ? t('owner.photos_pending_hint')
                : undefined
          }
        />
      </Card>

      {provider ? (
        <VerificationCard
          providerGuid={provider.guid}
          initial={provider.verification}
          disabled={busy}
        />
      ) : null}

      {provider ? (
        <Button
          label={t('owner.delete_provider')}
          variant="outline"
          tone="danger"
          onPress={remove}
          busy={deleting}
          disabled={saving || done}
          style={styles.remove}
        />
      ) : null}

      <CityPicker
        visible={cityOpen}
        cities={cities}
        selectedId={city?.id}
        onSelect={(picked) => {
          setCity(picked);
          clearErrors('city');
        }}
        onClose={() => setCityOpen(false)}
      />

      <Sheet
        visible={unitTarget !== null}
        onClose={() => setUnitTarget(null)}
        title={t('owner.unit_sheet_title')}
      >
        <ChipWrap>
          {UNITS.map((unit) => {
            const current = unitTarget?.kind === 'from'
              ? priceUnit
              : items.find((it) => unitTarget?.kind === 'item' && it.key === unitTarget.key)?.unit;
            return (
              <Chip
                key={unit}
                label={unitName(t, unit) ?? unit}
                selected={current === unit}
                onPress={() => pickUnit(unit)}
              />
            );
          })}
        </ChipWrap>
      </Sheet>

      <PhotoViewer
        visible={viewerIndex !== null}
        uris={fullUris}
        initialIndex={viewerIndex ?? 0}
        onClose={() => setViewerIndex(null)}
      />
    </Screen>
  );
}

/**
 * «Проверенный продавец»: продавец присылает БИН или ИИН, админ сверяет его
 * с реестром. Отдельно от «Сохранить»: это заявка на проверку, а не поле
 * карточки, и уходит она своим запросом.
 */
function VerificationCard({
  providerGuid,
  initial,
  disabled,
}: {
  providerGuid: string;
  initial: ProviderVerification | undefined;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const onTop = useOnTop();
  const [state, setState] = useState<ProviderVerification | undefined>(initial);
  const [bin, setBin] = useState(initial?.bin ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (bin.length !== BIN_DIGITS) {
      setError(t('owner.bin_invalid'));
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await subscriptionApi.requestVerification(providerGuid, bin);
      if (onTop.current) setState(res.verification);
    } catch (e) {
      if (onTop.current) setError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      setSending(false);
    }
  };

  const sameBin = !!state?.bin && state.bin === bin;
  let badge: ReactNode = null;
  if (state?.verified_at && sameBin) {
    badge = <Badge label={t('owner.verify_done')} tone="success" />;
  } else if (state?.requested_at && sameBin) {
    badge = <Badge label={t('owner.verify_waiting')} tone="warning" />;
  }

  return (
    // Статус — строкой под заголовком, а не справа от него: рядом с ним
    // длинный заголовок обрезался бы.
    <Card title={t('owner.verify_title')} hint={t('owner.verify_hint')}>
      {badge ? <View style={styles.verifyBadge}>{badge}</View> : null}
      <Field label={t('owner.bin_label')} error={error ?? undefined}>
        <Input
          value={bin}
          onChangeText={(value) => {
            setBin(onlyDigits(value, BIN_DIGITS));
            setError(null);
          }}
          placeholder={t('owner.bin_placeholder')}
          accessibilityLabel={t('owner.bin_label')}
          keyboardType="number-pad"
          invalid={!!error}
        />
      </Field>
      {sameBin && (state?.verified_at || state?.requested_at) ? null : (
        <Button
          label={t('owner.verify_send')}
          variant="outline"
          onPress={() => void send()}
          busy={sending}
          disabled={disabled}
        />
      )}
      <Text style={styles.sectionHint}>{t('owner.verify_pro_note')}</Text>
    </Card>
  );
}

function toDraft(item: PriceItem, index: number): ItemDraft {
  return {
    key: item.guid ?? `s-${index}`,
    name: item.name,
    unit: item.unit,
    price: item.price != null ? String(item.price) : '',
  };
}

/**
 * Ошибка под чипами категории или прайсом. Они не в Field, поэтому диктору её
 * проговариваем сами. Отдельным компонентом над карточкой с полями, а не
 * в самом экране: эффекты детей срабатывают раньше эффекта родителя, и
 * верхнюю ошибку формы диктор прочёл бы последней.
 */
function FieldErrorText({ message }: { message?: string }) {
  const styles = useThemedStyles(makeStyles);
  useAnnounce(message);
  if (!message) return null;
  return (
    <Text style={styles.fieldError} accessibilityRole="alert">
      {message}
    </Text>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Низ у Screen — строка: растягиваемся на всю ширину и ставим ошибку
    // над кнопкой столбиком.
    footer: { flex: 1, gap: 8 },
    chipsBlock: { gap: 6 },
    // Тот же вид, что у ошибки под полем в Field: чипы категории стоят вне
    // карточки, и обернуть их в Field значило бы потерять подпись раздела.
    fieldError: { fontSize: 13, color: colors.danger, paddingHorizontal: 4 },
    sectionHint: { fontSize: 13, color: colors.muted, paddingHorizontal: 4 },
    pair: { flexDirection: 'row', gap: space.gap },
    verifyBadge: { flexDirection: 'row' },
    planHint: { gap: 8, backgroundColor: `${colors.warning}1F` },
    planHintText: { fontSize: text.caption, lineHeight: 20, color: colors.text },
    half: { flex: 1, minWidth: 0 },
    // Удаление — в самом низу и с отступом от остального: мимо него не
    // промахиваются, целясь в фото.
    remove: { marginTop: space.gap },
  });
