/**
 * Типы данных из бэка.
 * snake_case сохраняем, чтобы не было конверсии и не потерять что-то при рефакторинге.
 */

export interface User {
  id: number;
  guid: string;
  phone: string;
  full_name: string | null;
  language: 'ru' | 'kz';
  /**
   * Принял ли человек действующие Условия использования. false — вход ещё
   * не закончен: шторка входа покажет шаг согласия. Поля нет вовсе, если
   * сервер старше него, — тогда согласие не спрашиваем: принять его негде.
   */
  terms_accepted?: boolean;
  /**
   * Номер действующей версии условий. Возвращается серверу вместе с
   * согласием: так он знает, какой текст человек видел.
   */
  terms_version?: string;
}

export interface AuthVerifyResponse {
  token: string;
  is_new_user: boolean;
  user: User;
}

export interface City {
  id: number;
  name_ru: string;
  name_kz: string;
}

// ---------------------- Categories / Providers ----------------------

/**
 * Вид объявления: магазин стройматериалов или бригада / мастер.
 * Задаётся категорией.
 */
export type ListingKind = 'material' | 'service';

export interface Category {
  id: number;
  code: string;
  kind: ListingKind;
  name_ru: string;
  name_kz: string;
  icon: string | null;
  sort_order: number;
}

/** Краткая категория внутри карточки и деталей объявления. */
export interface CategoryBrief {
  id: number;
  code: string;
  kind?: ListingKind;
  name_ru: string;
  name_kz: string;
}

/** Признак объявления: доставка, рассрочка, договор, гарантия… */
export interface ProviderAttr {
  id: number;
  code: string;
  name_ru: string;
  name_kz: string;
  icon: string | null;
}

export interface ProviderAttrType extends ProviderAttr {
  sort_order?: number;
  category_code?: string;
}

/** Единица измерения прайса (коды — libs/units.py на бэке). */
export type PriceUnit =
  | 'piece' | 'm2' | 'm3' | 'm' | 'kg' | 'ton' | 'bag' | 'pack'
  | 'roll' | 'sheet' | 'liter' | 'hour' | 'day' | 'trip' | 'object' | 'work';

export interface Unit {
  code: PriceUnit;
  name_ru: string;
  name_kz: string;
}

/** Позиция прайса: товар магазина или работа бригады. price null — договорная. */
export interface PriceItem {
  guid?: string;
  name: string;
  unit: PriceUnit;
  price: number | null;
  sort_order?: number;
}

/** Позиция прайса, совпавшая с текстом поиска, — под карточкой в списке. */
export interface MatchedItem {
  guid: string;
  name: string;
  unit: PriceUnit;
  price: number | null;
}

export interface ProviderBrief {
  id: number;
  guid: string;
  name: string;
  description: string | null;
  address?: string | null;
  price_from: number | null;
  price_unit: PriceUnit | null;
  latitude?: number | null;
  longitude?: number | null;
  is_active?: boolean;
}

export interface ProviderCardData {
  provider: ProviderBrief;
  category: CategoryBrief;
  city: City;
  main_photo: string | null;
  main_thumb: string | null;
  rating: { avg: number; count: number };
  /** Позиции прайса, совпавшие с текстом поиска (пусто без текста). */
  matched_items?: MatchedItem[];
}

export interface ProviderSearchResponse {
  items: ProviderCardData[];
  total: number;
  page: number;
  page_size: number;
}

/** Строка поиска по прайсам: позиция + чьё объявление. */
export interface ItemSearchRow {
  item: { guid: string; name: string; unit: PriceUnit; price: number | null };
  provider: { guid: string; name: string; address: string | null };
  category: CategoryBrief;
  city: City;
  main_thumb: string | null;
  rating: { avg: number; count: number };
}

export interface ItemSearchResponse {
  items: ItemSearchRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface PublicProviderDetails {
  id: number;
  guid: string;
  name: string;
  description: string | null;
  phone: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  price_from: number | null;
  price_unit: PriceUnit | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  photos: Photo[];
  attrs: ProviderAttr[];
  items: PriceItem[];
  category: CategoryBrief;
  city: City;
}

export interface ApiErrorBody {
  message?: string;
}

export interface Photo {
  id: number;
  file_path: string;
  thumb_path: string;
  sort_order: number;
}

// ---------------------- Bookings ----------------------

export type BookingStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled';

export interface Booking {
  id: number;
  guid: string;
  /** Желаемая дата доставки или начала работ. */
  event_date: string;
  /** Адрес объекта. */
  address: string | null;
  comment: string | null;
  status: BookingStatus;
  rejected_reason: string | null;
  created_at: string;
  updated_at: string;
  provider: {
    id: number;
    guid: string | null;
    name: string | null;
    category_code: string | null;
    category_kind: ListingKind | null;
  } | null;
  provider_deleted: boolean;
  client?: { name: string | null; phone: string | null };
}

// ---------------------- Reviews ----------------------

export interface Review {
  id: number;
  guid: string;
  rating: number;
  text: string | null;
  owner_reply: string | null;
  owner_reply_at: string | null;
  created_at: string;
  client_name: string;
}

export interface ReviewsResponse {
  items: Review[];
  avg_rating: number;
  reviews_count: number;
}

// ---------------------- Favorites ----------------------

export interface FavoriteItem extends ProviderCardData {
  type: 'provider';
  favorited_at: string;
}
