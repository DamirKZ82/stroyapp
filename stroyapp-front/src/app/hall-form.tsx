import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Keyboard, StyleSheet, Text, View, type TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, dictsApi, ownerHallsApi } from '@/api';
import type { HallBody, OwnerHallFull } from '@/api';
import type { Amenity } from '@/api/types';
import { Button } from '@/components/Button';
import { Card, RowGroup, SectionLabel, SwitchRow } from '@/components/Card';
import { Chip, ChipWrap } from '@/components/Chip';
import { ErrorBanner, Loader } from '@/components/Feedback';
import { Field, Input } from '@/components/Field';
import { PhotoStrip } from '@/components/PhotoStrip';
import { PhotoViewer } from '@/components/PhotoViewer';
import { Screen } from '@/components/Screen';
import { space, text, type ThemeColors } from '@/theme';
import { useThemedStyles } from '@/theme/scheme';
import { confirmDestructive, showThen } from '@/utils/alert';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { useOnTop } from '@/utils/nav';
import { intOrNull, onlyDigits } from '@/utils/number';
import { photoUrl } from '@/utils/photo';
import { pickPhotos } from '@/utils/pickPhotos';

/** Столько фото на зал принимает сервер; лишние он отклоняет всей пачкой. */
const PHOTO_LIMIT = 20;

// Пределы сервера. Длину режем прямо в поле, а цену проверяем перед
// отправкой: его собственные ответы на это — только по-русски.
const NAME_MAX = 200;
const DESCRIPTION_MAX = 5000;
const PRICE_MAX = 1_000_000_000;

type FieldKey = 'name' | 'area' | 'capacity' | 'priceWeekday' | 'priceWeekend';
type FieldErrors = Partial<Record<FieldKey, string>>;

/** Порядок полей на экране: в полосе у кнопки показываем ошибку верхнего. */
const FIELD_ORDER: FieldKey[] = ['name', 'area', 'capacity', 'priceWeekday', 'priceWeekend'];

/**
 * Зал: создание, правка, фото и удаление.
 *
 * Фото привязаны к уже существующему залу, поэтому у нового зала блока фото
 * нет, пока его не сохранили. После первого сохранения форма остаётся на
 * месте и становится формой правки — человек сразу добавляет фото, а не
 * ищет только что созданный зал в списке.
 */
export default function HallFormScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const styles = useThemedStyles(makeStyles);
  const { venueGuid, hallGuid } = useLocalSearchParams<{ venueGuid: string; hallGuid?: string }>();

  const [amenitiesAll, setAmenitiesAll] = useState<Amenity[]>([]);
  const [hall, setHall] = useState<OwnerHallFull | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [areaSqm, setAreaSqm] = useState('');
  const [capMin, setCapMin] = useState('');
  const [capMax, setCapMax] = useState('');
  const [priceWeekday, setPriceWeekday] = useState('');
  const [priceWeekend, setPriceWeekend] = useState('');
  const [amenityIds, setAmenityIds] = useState<number[]>([]);
  const [isActive, setIsActive] = useState(true);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Правка сохранена или зал удалён: форма доживает до закрытия и ничего не принимает. */
  const [done, setDone] = useState(false);
  /** Ответ сервера или сбой с фото; ошибки полей лежат отдельно, в errors. */
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  /** С какого фото открыт просмотр; null — закрыт. */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // Для какого зала форма уже заполнена ('' — новый). После создания
  // router.setParams меняет hallGuid, и без этой отметки эффект загрузки
  // сработал бы снова: вертушка на весь экран и повторный запрос зала,
  // который только что пришёл в ответе на создание.
  const loadedFor = useRef<string | null>(null);

  // Поля, к которым проверка подводит при ошибке (см. focusFirstError).
  const nameRef = useRef<TextInput>(null);
  const areaRef = useRef<TextInput>(null);
  const capMinRef = useRef<TextInput>(null);
  const capMaxRef = useRef<TextInput>(null);
  const priceWeekdayRef = useRef<TextInput>(null);
  const priceWeekendRef = useRef<TextInput>(null);

  // Сверху ли ещё форма. Человек может уйти назад, не дождавшись ответа, или
  // поверх откроется экран по ссылке, а router действует на тот экран, что
  // сейчас сверху: setParams записал бы hallGuid чужому экрану, а «назад»
  // после удаления закрыл бы ещё и экран заведения.
  const onTop = useOnTop();

  const load = useCallback(
    async (guid: string | undefined) => {
      loadedFor.current = guid ?? '';
      setLoading(true);
      setLoadError(null);
      // Удобства необязательны, поэтому сбой справочника не должен ронять всю
      // форму — просто не будет чипов. Выбранные у зала amenity_ids при этом
      // приходят с самим залом и уходят при сохранении без изменений.
      const amenitiesRequest = dictsApi
        .amenities()
        .then((resp) => resp.items)
        .catch(() => [] as Amenity[]);
      try {
        const [dict, found] = await Promise.all([
          amenitiesRequest,
          guid ? ownerHallsApi.get(guid) : Promise.resolve(null),
        ]);
        setAmenitiesAll(dict);
        if (found) {
          const v = found.hall;
          setHall(v);
          setName(v.name);
          setDescription(v.description ?? '');
          setAreaSqm(v.area_sqm != null ? String(v.area_sqm) : '');
          setCapMin(v.capacity_min != null ? String(v.capacity_min) : '');
          setCapMax(v.capacity_max != null ? String(v.capacity_max) : '');
          setPriceWeekday(String(v.price_weekday));
          setPriceWeekend(String(v.price_weekend));
          setAmenityIds(v.amenities.map((x) => x.id));
          setIsActive(v.is_active);
        }
      } catch (e) {
        setLoadError(e instanceof ApiError ? e.message : t('common.error_generic'));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  // Только при открытии, без обновления по фокусу: возврат на экран не должен
  // затирать то, что человек уже набрал в форме.
  useEffect(() => {
    if (loadedFor.current === (hallGuid ?? '')) return;
    void load(hallGuid);
  }, [hallGuid, load]);

  const clearFieldError = (key: FieldKey) =>
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const toggleAmenity = (id: number) =>
    setAmenityIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const priceError = (value: string, requiredKey: string): string | null => {
    const n = intOrNull(value);
    if (n === null) return t(requiredKey);
    if (n > PRICE_MAX) return t('owner.price_too_high');
    return null;
  };

  const validate = (): FieldErrors => {
    const found: FieldErrors = {};
    if (!name.trim()) found.name = t('owner.name_required');

    // Пустые площадь и вместимость допустимы, ноль — нет: сервер его отклонит.
    if (intOrNull(areaSqm) === 0) found.area = t('owner.area_invalid');
    const min = intOrNull(capMin);
    const max = intOrNull(capMax);
    if (min === 0 || max === 0) found.capacity = t('owner.capacity_invalid');
    else if (min !== null && max !== null && min > max) found.capacity = t('owner.capacity_range_invalid');

    const weekday = priceError(priceWeekday, 'owner.price_weekday_required');
    if (weekday) found.priceWeekday = weekday;
    const weekend = priceError(priceWeekend, 'owner.price_weekend_required');
    if (weekend) found.priceWeekend = weekend;
    return found;
  };

  /**
   * Подводит человека к первой ошибке, как в форме исполнителя. Кнопка
   * «Сохранить» закреплена внизу, а поле с ошибкой может быть прокручено за
   * край: полоса над кнопкой говорит, что не так, фокус — показывает где.
   */
  const focusFirstError = (found: FieldErrors) => {
    const first = FIELD_ORDER.find((key) => found[key]);
    if (first === 'name') nameRef.current?.focus();
    else if (first === 'area') areaRef.current?.focus();
    else if (first === 'capacity') {
      // У пары полей ошибка общая. В «до» ведём, только когда дело в нём
      // одном (там ноль); перепутанные границы правят с первого поля.
      const onlyMax = intOrNull(capMin) !== 0 && intOrNull(capMax) === 0;
      (onlyMax ? capMaxRef : capMinRef).current?.focus();
    } else if (first === 'priceWeekday') priceWeekdayRef.current?.focus();
    else if (first === 'priceWeekend') priceWeekendRef.current?.focus();
  };

  // Замок, а не только состояние: два быстрых нажатия успевают пройти до
  // перерисовки кнопки, и у нового зала это были бы два одинаковых зала.
  const saveLock = useRef(false);

  const submit = async () => {
    if (saveLock.current) return;
    setError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstError(found);
      return;
    }
    // Клавиатуру убираем только когда ошибок нет: иначе у поля, в котором
    // человек уже стоит, она закрылась бы и тут же открылась снова.
    Keyboard.dismiss();

    const descriptionText = description.trim();
    const body: Omit<HallBody, 'venue_guid' | 'description'> = {
      name: name.trim(),
      area_sqm: intOrNull(areaSqm),
      capacity_min: intOrNull(capMin),
      capacity_max: intOrNull(capMax),
      price_weekday: intOrNull(priceWeekday) ?? 0,
      price_weekend: intOrNull(priceWeekend) ?? 0,
      amenity_ids: amenityIds,
    };

    saveLock.current = true;
    setSaving(true);
    const editing = !!hall;
    try {
      if (hall) {
        const res = await ownerHallsApi.patch(hall.guid, {
          ...body,
          // При правке null для сервера значит «не менять», и стёртое описание
          // возвращалось бы после сохранения. Пустая строка его стирает; шлём
          // её только когда стирать есть что, чтобы не плодить '' вместо NULL.
          description: descriptionText || (hall.description ? '' : null),
          is_active: isActive,
        });
        setHall(res.hall);
      } else {
        const res = await ownerHallsApi.create({
          ...body,
          venue_guid: venueGuid,
          description: descriptionText || null,
        });
        // Форма становится правкой на месте: зал уже есть в ответе, перечитывать
        // его не нужно — отметка стоит до смены параметра.
        loadedFor.current = res.hall.guid;
        setHall(res.hall);
        setIsActive(res.hall.is_active);
        if (onTop.current) router.setParams({ hallGuid: res.hall.guid });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      saveLock.current = false;
      setSaving(false);
      return;
    }

    // Новый зал: форма остаётся открытой — следующий шаг, фото, здесь же.
    if (!editing) {
      saveLock.current = false;
      setSaving(false);
      // Форму могли закрыть, не дождавшись ответа: «Сохранено» поверх
      // другого экрана ни к чему.
      if (onTop.current) Alert.alert(t('common.saved'));
      return;
    }
    // Форму накрыли другим экраном, пока шёл запрос: закрыть её значило бы
    // закрыть его. Правка сохранена — просто отпускаем кнопку, чтобы после
    // возврата форма не крутила вертушку без конца.
    if (!onTop.current) {
      saveLock.current = false;
      setSaving(false);
      return;
    }

    // Правка закончена — закрываем, как формы заведения и исполнителя. Замок
    // не снимаем: за время сообщения и анимации второе нажатие отправило бы
    // форму ещё раз.
    setSaving(false);
    setDone(true);
    // Возвращаться некуда, если форму открыли ссылкой, — тогда к списку.
    showThen(t('common.saved'), undefined, () => {
      if (!onTop.current) return;
      if (router.canGoBack()) router.back();
      else router.replace('/my-listings');
    });
  };

  // Плитка «добавить» гаснет только на время загрузки, а до неё ещё сама
  // галерея: второе нажатие открыло бы её дважды.
  const pickLock = useRef(false);

  const addPhotos = async () => {
    if (!hall || pickLock.current) return;
    const room = PHOTO_LIMIT - hall.photos.length;
    if (room <= 0) return;

    pickLock.current = true;
    setError(null);
    try {
      // Доступ к фото pickPhotos не запрашивает (почему — см. там): раньше
      // отказ в доступе закрывал добавление фото насовсем.
      const files = await pickPhotos(room);
      if (!files?.length) return;

      setUploading(true);
      const res = await ownerHallsApi.uploadPhotos(hall.guid, files);
      // От текущего состояния, а не от зала из замыкания: пока шла загрузка,
      // человек мог удалить фото или сохранить форму. Если ответ сохранения
      // уже принёс эти фото, второй раз их не добавляем — иначе в ленте
      // будут два одинаковых ключа.
      setHall((prev) => {
        if (!prev) return prev;
        const have = new Set(prev.photos.map((p) => p.id));
        return { ...prev, photos: [...prev.photos, ...res.items.filter((p) => !have.has(p.id))] };
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
    } finally {
      pickLock.current = false;
      setUploading(false);
    }
  };

  // Фото, которые уже удаляются. Плитка на время запроса не меняется, и
  // второе нажатие на тот же крестик отправило бы второй запрос — сервер
  // ответил бы на него «Фото не найдено» поверх успешного удаления.
  const removingPhotos = useRef(new Set<number>());
  // Копия размера набора для кнопки «Сохранить»: изменение ref экран не
  // перерисует, и кнопка не узнала бы, что удаление ещё идёт.
  const [removingCount, setRemovingCount] = useState(0);

  const deletePhoto = (key: string) => {
    const photoId = Number(key);
    if (Number.isNaN(photoId) || removingPhotos.current.has(photoId)) return;
    confirmDestructive(t('owner.delete_photo_title'), undefined, async () => {
      if (removingPhotos.current.has(photoId)) return;
      removingPhotos.current.add(photoId);
      setRemovingCount(removingPhotos.current.size);
      setError(null);
      try {
        await ownerHallsApi.deletePhoto(photoId);
        setHall((prev) => (prev ? { ...prev, photos: prev.photos.filter((p) => p.id !== photoId) } : prev));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      } finally {
        removingPhotos.current.delete(photoId);
        setRemovingCount(removingPhotos.current.size);
      }
    });
  };

  const remove = () => {
    if (!hall || saveLock.current) return;
    const guid = hall.guid;
    const doRemove = async () => {
      setError(null);
      setDeleting(true);
      try {
        await ownerHallsApi.remove(guid);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('common.error_generic'));
        setDeleting(false);
        return;
      }
      // Форму накрыли другим экраном: «назад» закрыл бы его. Зала уже нет —
      // гасим форму, уйти с неё можно кнопкой «Назад» в шапке.
      if (!onTop.current) {
        setDeleting(false);
        setDone(true);
        return;
      }
      // Возвращаться некуда, если форму открыли ссылкой, — тогда к списку:
      // иначе человек остался бы на форме уже удалённого зала.
      if (router.canGoBack()) router.back();
      else router.replace('/my-listings');
    };
    confirmDestructive(
      t('owner.delete_hall_confirm_title'),
      t('owner.delete_hall_confirm_text'),
      () => void doRemove(),
    );
  };

  // Лента и просмотр строятся из одного списка: номер плитки в ленте должен
  // совпадать с номером фото в просмотре.
  const photos = useMemo(() => {
    const list: { key: string; uri: string; full: string }[] = [];
    for (const p of hall?.photos ?? []) {
      const full = photoUrl(p.file_path);
      const thumb = photoUrl(p.thumb_path) ?? full;
      if (thumb) list.push({ key: String(p.id), uri: thumb, full: full ?? thumb });
    }
    return list;
  }, [hall?.photos]);
  const fullUris = useMemo(() => photos.map((p) => p.full), [photos]);

  // По залу, а не только по параметру: сразу после создания зал уже есть, а
  // параметр меняется кадром позже. По параметру — чтобы заголовок правки
  // стоял с первого кадра, пока зал ещё грузится.
  const isEdit = !!hall || !!hallGuid;
  const title = t(isEdit ? 'owner.hall_form_edit' : 'owner.hall_form_new');
  const header = <Stack.Screen options={{ headerShown: true, title }} />;

  if (loading) {
    return (
      <Screen>
        {header}
        <Loader />
      </Screen>
    );
  }

  // Не показываем пустую форму поверх ошибки: в режиме правки сохранение
  // такой формы создало бы второй зал вместо изменения этого.
  if (loadError) {
    return (
      <Screen scroll>
        {header}
        <ErrorBanner message={loadError} />
        <Button label={t('common.retry')} variant="outline" onPress={() => void load(hallGuid)} />
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
          {/* Ошибку поля диктору уже проговорил её Field — полоса лишь
              показывает её зрячим и второй раз не объявляет. */}
          <ErrorBanner message={error ?? fieldError} announce={!!error} />
          {/* Пока фото грузятся или удаляются, не сохраняем: сохранение правки
              закрывает форму, и сбой с фото показать было бы уже негде — а
              «удалённое» фото осталось бы в объявлении. */}
          <Button
            label={t('common.save')}
            onPress={submit}
            busy={saving}
            disabled={deleting || done || uploading || removingCount > 0}
          />
        </View>
      }
    >
      {header}

      <Card>
        <Field label={t('owner.hall_name_label')} error={errors.name}>
          <Input
            value={name}
            onChangeText={(v) => {
              setName(v);
              clearFieldError('name');
            }}
            ref={nameRef}
            placeholder={t('owner.hall_name_placeholder')}
            // Подпись над полем — отдельный текст: диктор без этого назвал бы
            // поле по примеру из подсказки или вовсе никак (у площади её нет).
            accessibilityLabel={t('owner.hall_name_label')}
            maxLength={NAME_MAX}
            invalid={!!errors.name}
          />
        </Field>
        <Field label={t('owner.hall_description_label')}>
          <Input
            value={description}
            onChangeText={setDescription}
            placeholder={t('owner.hall_description_placeholder')}
            accessibilityLabel={t('owner.hall_description_label')}
            multiline
            maxLength={DESCRIPTION_MAX}
          />
        </Field>
      </Card>

      <Card>
        <Field label={t('owner.area_sqm_label')} error={errors.area}>
          <Input
            value={areaSqm}
            onChangeText={(v) => {
              setAreaSqm(onlyDigits(v, 5));
              clearFieldError('area');
            }}
            ref={areaRef}
            keyboardType="number-pad"
            accessibilityLabel={t('owner.area_sqm_label')}
            invalid={!!errors.area}
          />
        </Field>
        <Field label={t('owner.capacity_label')} error={errors.capacity}>
          <View style={styles.pair}>
            <Input
              value={capMin}
              onChangeText={(v) => {
                setCapMin(onlyDigits(v, 5));
                clearFieldError('capacity');
              }}
              ref={capMinRef}
              keyboardType="number-pad"
              placeholder={t('owner.capacity_min_placeholder')}
              // У пары полей подпись одна на двоих — диктору называем каждое.
              accessibilityLabel={`${t('owner.capacity_label')}, ${t('owner.capacity_min_placeholder')}`}
              invalid={!!errors.capacity}
              style={styles.half}
            />
            <Input
              value={capMax}
              onChangeText={(v) => {
                setCapMax(onlyDigits(v, 5));
                clearFieldError('capacity');
              }}
              ref={capMaxRef}
              keyboardType="number-pad"
              placeholder={t('owner.capacity_max_placeholder')}
              accessibilityLabel={`${t('owner.capacity_label')}, ${t('owner.capacity_max_placeholder')}`}
              invalid={!!errors.capacity}
              style={styles.half}
            />
          </View>
        </Field>
        <Field label={t('owner.price_weekday_label')} error={errors.priceWeekday}>
          <Input
            value={priceWeekday}
            onChangeText={(v) => {
              setPriceWeekday(onlyDigits(v, 10));
              clearFieldError('priceWeekday');
            }}
            ref={priceWeekdayRef}
            keyboardType="number-pad"
            placeholder="200000"
            accessibilityLabel={t('owner.price_weekday_label')}
            invalid={!!errors.priceWeekday}
          />
        </Field>
        <Field label={t('owner.price_weekend_label')} error={errors.priceWeekend}>
          <Input
            value={priceWeekend}
            onChangeText={(v) => {
              setPriceWeekend(onlyDigits(v, 10));
              clearFieldError('priceWeekend');
            }}
            ref={priceWeekendRef}
            keyboardType="number-pad"
            placeholder="400000"
            accessibilityLabel={t('owner.price_weekend_label')}
            invalid={!!errors.priceWeekend}
          />
        </Field>
      </Card>

      {amenitiesAll.length > 0 ? (
        <>
          <SectionLabel>{t('owner.amenities_label')}</SectionLabel>
          <ChipWrap>
            {amenitiesAll.map((a) => (
              <Chip
                key={a.id}
                label={dictName(a, lang)}
                selected={amenityIds.includes(a.id)}
                onPress={() => toggleAmenity(a.id)}
              />
            ))}
          </ChipWrap>
        </>
      ) : null}

      {/* Новый зал сервер создаёт опубликованным, снять с публикации можно
          только существующий — до сохранения переключатель был бы пустышкой. */}
      {hall ? (
        <RowGroup>
          <SwitchRow
            first
            label={t('owner.is_active_label')}
            value={isActive}
            onValueChange={setIsActive}
            disabled={busy}
          />
        </RowGroup>
      ) : null}

      <SectionLabel>{t('owner.photos_label')}</SectionLabel>
      <Card>
        {hall ? (
          <PhotoStrip
            photos={photos}
            limit={PHOTO_LIMIT}
            onAdd={addPhotos}
            onRemove={deletePhoto}
            onOpen={setViewerIndex}
            busy={uploading}
            disabled={busy}
            hint={uploading ? t('owner.photos_uploading') : undefined}
          />
        ) : (
          <Text style={styles.hint}>{t('owner.save_first_hint')}</Text>
        )}
      </Card>

      {hall ? (
        <Button
          label={t('owner.delete_hall')}
          variant="outline"
          tone="danger"
          onPress={remove}
          busy={deleting}
          disabled={saving || uploading || done}
          style={styles.remove}
        />
      ) : null}

      <PhotoViewer
        visible={viewerIndex !== null}
        uris={fullUris}
        initialIndex={viewerIndex ?? 0}
        onClose={() => setViewerIndex(null)}
      />
    </Screen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    footer: { flex: 1, gap: 8 },
    pair: { flexDirection: 'row', gap: space.gap },
    half: { flex: 1, minWidth: 0 },
    hint: { fontSize: text.caption, color: colors.muted },
    // Удаление — в самом низу и с отступом от остального: мимо него не
    // промахиваются, целясь в фото.
    remove: { marginTop: space.gap },
  });
