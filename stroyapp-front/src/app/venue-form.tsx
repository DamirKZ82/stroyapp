import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, View, type TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, dictsApi, venuesApi, type City, type VenueBody } from '@/api';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { CityPicker } from '@/components/CityPicker';
import { ErrorBanner, Loader } from '@/components/Feedback';
import { Field, Input, SelectField } from '@/components/Field';
import { Screen } from '@/components/Screen';
import { space } from '@/theme';
import { confirmDestructive, showThen } from '@/utils/alert';
import { parseCoord, splitCoordPaste } from '@/utils/coords';
import { dictName } from '@/utils/i18nDict';
import { useLang } from '@/utils/lang';
import { useOnTop } from '@/utils/nav';

// Пределы сервера (r20_venues.py). Длиннее он отклонит — лучше не дать
// набрать, чем вернуть ошибку после «Сохранить».
const NAME_MAX = 200;
const ADDRESS_MAX = 500;
const DESCRIPTION_MAX = 5000;
const PHONE_MAX = 20;

type FieldKey = 'city' | 'name' | 'address' | 'lat' | 'lng';
type FieldErrors = Partial<Record<FieldKey, string>>;

/** Порядок полей на экране: в полосе у кнопки показываем ошибку верхнего. */
const FIELD_ORDER: FieldKey[] = ['city', 'name', 'address', 'lat', 'lng'];

/**
 * Форма заведения: создание (без venueGuid) и правка с удалением.
 *
 * Справочник городов и само заведение грузятся один раз при открытии, а не
 * на каждый фокус: повторная загрузка стёрла бы то, что человек уже набрал.
 */
export default function VenueFormScreen() {
  const { t } = useTranslation();
  const lang = useLang();
  const { venueGuid } = useLocalSearchParams<{ venueGuid?: string }>();
  const isEdit = !!venueGuid;

  const [cities, setCities] = useState<City[]>([]);
  const [city, setCity] = useState<City | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [phone, setPhone] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');

  const [cityOpen, setCityOpen] = useState(false);
  // Новое заведение показываем сразу: пока едет справочник городов, можно
  // уже набирать название. При правке ждём — пустая форма выглядела бы так,
  // будто данные пропали.
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Сохранено, экран закрывается: форма доживает под сообщением об успехе. */
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  // Замок, а не только состояние: два быстрых нажатия на «Сохранить»
  // успевают пройти до перерисовки кнопки и создали бы два заведения.
  const locked = useRef(false);

  /** Описание и телефон с сервера: по ним видно, есть ли что стирать при правке. */
  const original = useRef({ description: '', phone: '' });

  // Сверху ли ещё форма. Человек может уйти назад, не дождавшись ответа, или
  // поверх откроется другой экран, а router действует на тот экран, что
  // сейчас сверху: «назад» после сохранения закрыл бы уже не форму.
  const onTop = useOnTop();

  const nameRef = useRef<TextInput>(null);
  const addressRef = useRef<TextInput>(null);
  const descriptionRef = useRef<TextInput>(null);
  const latRef = useRef<TextInput>(null);
  const lngRef = useRef<TextInput>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [dict, details] = await Promise.all([
          dictsApi.cities(),
          venueGuid ? venuesApi.get(venueGuid) : null,
        ]);
        if (!alive) return;
        setCities(dict.items);
        if (details) {
          const v = details.venue;
          setCity(dict.items.find((c) => c.id === v.city_id) ?? null);
          setName(v.name);
          setAddress(v.address);
          original.current = { description: v.description ?? '', phone: v.phone ?? '' };
          setDescription(v.description ?? '');
          setPhone(v.phone ?? '');
          setLat(v.latitude != null ? String(v.latitude) : '');
          setLng(v.longitude != null ? String(v.longitude) : '');
        }
        setLoadError(null);
      } catch (e) {
        if (alive) setLoadError(e instanceof ApiError ? e.message : t('common.error_generic'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // t в зависимостях нет намеренно: смена языка перезапустила бы загрузку
    // и затёрла набранное значениями с сервера.
  }, [venueGuid, attempt]);

  const retryLoad = () => {
    setLoadError(null);
    setLoading(isEdit);
    setAttempt((n) => n + 1);
  };

  const clearErrors = (...keys: FieldKey[]) =>
    setErrors((prev) => {
      if (!keys.some((key) => prev[key])) return prev;
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });

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
   * а поле с ошибкой может быть прокручено за край: без этого нажатие
   * выглядело бы так, будто ничего не произошло.
   */
  const showFirstError = (found: FieldErrors) => {
    if (found.city) {
      // Город — не поле ввода, фокус ему не дать. Открываем сам выбор; если
      // справочник не загрузился, шторка была бы пустой — тогда не трогаем.
      if (cities.length > 0) {
        Keyboard.dismiss();
        setCityOpen(true);
      }
    } else if (found.name) nameRef.current?.focus();
    else if (found.address) addressRef.current?.focus();
    else if (found.lat) latRef.current?.focus();
    else if (found.lng) lngRef.current?.focus();
  };

  const submit = async () => {
    if (locked.current) return;

    const latitude = parseCoord(lat, 90);
    const longitude = parseCoord(lng, 180);

    const found: FieldErrors = {};
    if (!city) found.city = t('owner.venue_city_required');
    if (!name.trim()) found.name = t('owner.name_required');
    if (!address.trim()) found.address = t('owner.venue_address_required');
    if (latitude === undefined) found.lat = t('owner.latitude_invalid');
    if (longitude === undefined) found.lng = t('owner.longitude_invalid');
    // Одна координата без другой бесполезна: маршрут в 2GIS строится только
    // по паре, и владелец не понял бы, почему кнопка ведёт в поиск по адресу.
    const bothParsed = latitude !== undefined && longitude !== undefined;
    if (bothParsed && (latitude === null) !== (longitude === null)) {
      found[latitude === null ? 'lat' : 'lng'] = t('owner.coordinates_both_required');
    }

    if (!city || Object.keys(found).length > 0) {
      setErrors(found);
      setError(null);
      showFirstError(found);
      return;
    }

    // PATCH на сервере читает null как «поле не трогать», поэтому стёртые
    // описание и телефон при правке уходят пустой строкой — иначе их нельзя
    // было бы убрать. Шлём её, только когда стирать есть что, как формы зала
    // и исполнителя: сервер хранит '' как есть, и пустые поля иначе
    // превращались бы из NULL в ''. При создании original пуст — уйдёт null.
    const body: VenueBody = {
      city_id: city.id,
      name: name.trim(),
      address: address.trim(),
      description: description.trim() || (original.current.description ? '' : null),
      phone: phone.trim() || (original.current.phone ? '' : null),
      latitude: latitude ?? null,
      longitude: longitude ?? null,
    };

    locked.current = true;
    Keyboard.dismiss();
    setSaving(true);
    setError(null);
    setErrors({});
    try {
      if (venueGuid) await venuesApi.patch(venueGuid, body);
      else await venuesApi.create(body);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      setSaving(false);
      locked.current = false;
      return;
    }

    // Замок после успеха не снимаем: экран закрывается, и за время
    // сообщения и анимации второе нажатие отправило бы форму ещё раз.
    setSaving(false);
    setDone(true);
    // Форму закрыли или накрыли другим экраном, пока шёл запрос: «Сохранено»
    // поверх чужого экрана ни к чему, а «назад» закрыл бы его. Форма остаётся
    // погашенной, а не открытой снова: новое заведение повторное «Сохранить»
    // создало бы второй раз. Уйти с неё — кнопкой «Назад» в шапке.
    if (!onTop.current) return;
    // Возвращаться некуда, если форму открыли ссылкой, — тогда к списку.
    showThen(t('common.saved'), undefined, () => {
      if (!onTop.current) return;
      if (router.canGoBack()) router.back();
      else router.replace('/my-listings');
    });
  };

  const remove = async () => {
    if (!venueGuid || locked.current) return;
    locked.current = true;
    setDeleting(true);
    setError(null);
    try {
      await venuesApi.remove(venueGuid);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.error_generic'));
      setDeleting(false);
      locked.current = false;
      return;
    }
    // Форму закрыли или накрыли, пока шёл запрос, — router увёл бы уже
    // чужой экран. Заведения нет: гасим форму, а не отпускаем замок.
    if (!onTop.current) {
      setDeleting(false);
      setDone(true);
      return;
    }
    // Под формой в стеке остался экран удалённого заведения — назад на него
    // нельзя, сразу к списку объявлений.
    router.dismissTo('/my-listings');
  };

  const confirmRemove = () => {
    if (locked.current) return;
    confirmDestructive(
      t('owner.delete_venue_confirm_title'),
      t('owner.delete_venue_confirm_text'),
      () => void remove(),
    );
  };

  const title = isEdit ? t('owner.venue_form_edit') : t('owner.venue_form_new');

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: true, title }} />
        <Loader />
      </Screen>
    );
  }

  // Заведение не загрузилось: пустую форму при правке не показываем — её
  // можно было бы заполнить заново и сохранить поверх настоящих данных.
  if (isEdit && loadError) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ headerShown: true, title }} />
        <ErrorBanner message={loadError} />
        <Button label={t('common.retry')} variant="outline" onPress={retryLoad} />
      </Screen>
    );
  }

  // Ошибка у кнопки, а не вверху формы: низ закреплён и виден всегда, а
  // верх длинной формы к моменту нажатия обычно уже прокручен за край. Из
  // ошибок полей — верхняя: без справочника городов выбор города не
  // открыть, и иначе нажатие выглядело бы так, будто ничего не произошло.
  const fieldError = FIELD_ORDER.map((key) => errors[key]).find(Boolean) ?? null;

  return (
    <Screen
      scroll
      footer={
        <View style={styles.footer}>
          {/* Ошибку поля диктору уже проговорил её Field — полоса лишь
              показывает её зрячим и второй раз не объявляет. */}
          <ErrorBanner message={error ?? fieldError} announce={!!error} />
          <Button label={t('common.save')} onPress={submit} busy={saving} disabled={deleting || done} />
        </View>
      }
    >
      <Stack.Screen options={{ headerShown: true, title }} />

      {loadError ? (
        <>
          <ErrorBanner message={loadError} />
          <Button label={t('common.retry')} variant="outline" onPress={retryLoad} />
        </>
      ) : null}

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
            // Без справочника шторка открылась бы с «Город не найден».
            disabled={cities.length === 0}
          />
        </Field>

        <Field label={t('owner.venue_name_label')} error={errors.name}>
          <Input
            ref={nameRef}
            value={name}
            onChangeText={(value) => {
              setName(value);
              clearErrors('name');
            }}
            placeholder={t('owner.venue_name_placeholder')}
            accessibilityLabel={t('owner.venue_name_label')}
            maxLength={NAME_MAX}
            invalid={!!errors.name}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => addressRef.current?.focus()}
          />
        </Field>

        <Field label={t('owner.venue_address_label')} error={errors.address}>
          <Input
            ref={addressRef}
            value={address}
            onChangeText={(value) => {
              setAddress(value);
              clearErrors('address');
            }}
            placeholder={t('owner.venue_address_placeholder')}
            accessibilityLabel={t('owner.venue_address_label')}
            maxLength={ADDRESS_MAX}
            invalid={!!errors.address}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => descriptionRef.current?.focus()}
          />
        </Field>

        <Field label={t('owner.venue_description_label')}>
          <Input
            ref={descriptionRef}
            value={description}
            onChangeText={setDescription}
            placeholder={t('owner.venue_description_placeholder')}
            accessibilityLabel={t('owner.venue_description_label')}
            maxLength={DESCRIPTION_MAX}
            multiline
          />
        </Field>

        {/* Телефон — как введён, без маски мобильного: у заведения бывает
            городской номер, а сервер хранит строку как есть. */}
        <Field label={t('owner.venue_phone_label')}>
          <Input
            value={phone}
            onChangeText={setPhone}
            placeholder={t('owner.venue_phone_placeholder')}
            accessibilityLabel={t('owner.venue_phone_label')}
            maxLength={PHONE_MAX}
            keyboardType="phone-pad"
          />
        </Field>

        <Field
          label={t('owner.coordinates_label')}
          hint={t('owner.coordinates_optional_hint')}
          error={errors.lat ?? errors.lng}
        >
          <View style={styles.coords}>
            <Input
              ref={latRef}
              value={lat}
              onChangeText={(value) => onCoordChange('lat', value)}
              placeholder={t('owner.latitude')}
              accessibilityLabel={t('owner.latitude')}
              // Не цифровая: на ней нет минуса и запятой.
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              invalid={!!errors.lat}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => lngRef.current?.focus()}
              style={styles.coord}
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
              style={styles.coord}
            />
          </View>
        </Field>
      </Card>

      {isEdit ? (
        <Button
          label={t('owner.delete_venue')}
          variant="outline"
          tone="danger"
          onPress={confirmRemove}
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Низ у Screen — строка: растягиваемся на всю ширину и ставим ошибку
  // над кнопкой столбиком.
  footer: { flex: 1, gap: 8 },
  coords: { flexDirection: 'row', gap: space.gap },
  coord: { flex: 1, minWidth: 0 },
  // Удаление — в стороне от полей, чтобы не попасть в него заодно.
  remove: { marginTop: space.gap },
});
