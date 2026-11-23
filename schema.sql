-- =============================================================================
-- VeloFox Dispatch Software — PostgreSQL schema
-- -----------------------------------------------------------------------------
-- Apply with:
--   psql "$DATABASE_URL" -f schema.sql
--
-- Safe to re-run: every object is created only when it does not already exist.
-- Requires PostgreSQL 13+ (gen_random_uuid() is built in).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Fleet inventory
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category      text NOT NULL,
    license_plate varchar(16) NOT NULL,
    status        text NOT NULL DEFAULT 'available',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vehicles_category_check
        CHECK (category IN ('sedan', 'suv', 'sprinter', 'limousine')),
    CONSTRAINT vehicles_license_plate_check
        CHECK (btrim(license_plate) <> ''),
    CONSTRAINT vehicles_license_plate_key
        UNIQUE (license_plate),
    CONSTRAINT vehicles_status_check
        CHECK (status IN ('available', 'assigned', 'maintenance', 'out_of_service'))
);

COMMENT ON TABLE vehicles IS 'Fleet vehicles available for dispatcher assignment.';
COMMENT ON COLUMN vehicles.id IS 'Surrogate primary key referenced by bookings.vehicle_id.';
COMMENT ON COLUMN vehicles.category IS 'Vehicle class: sedan | suv | sprinter | limousine.';
COMMENT ON COLUMN vehicles.license_plate IS 'Registration plate; unique across the fleet.';
COMMENT ON COLUMN vehicles.status IS 'available | assigned | maintenance | out_of_service.';

CREATE INDEX IF NOT EXISTS vehicles_status_idx ON vehicles (status);
CREATE INDEX IF NOT EXISTS vehicles_category_idx ON vehicles (category);

-- -----------------------------------------------------------------------------
-- Chauffeurs
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drivers (
    id            varchar(50) PRIMARY KEY,
    display_name  varchar(120) NOT NULL,
    phone         varchar(30),
    status        text NOT NULL DEFAULT 'available',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT drivers_id_check CHECK (btrim(id) <> ''),
    CONSTRAINT drivers_display_name_check CHECK (btrim(display_name) <> ''),
    CONSTRAINT drivers_status_check
        CHECK (status IN ('available', 'assigned', 'off_duty'))
);

COMMENT ON TABLE drivers IS 'Chauffeur identities used to retrieve assigned trip manifests.';

-- Dispatch "ping fleet" markers, polled by the driver portal as notifications.
CREATE TABLE IF NOT EXISTS dispatch_pings (
    id         bigserial PRIMARY KEY,
    driver_id  varchar(50) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT dispatch_pings_driver_id_fkey
        FOREIGN KEY (driver_id) REFERENCES drivers (id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS dispatch_pings_driver_created_idx
    ON dispatch_pings (driver_id, created_at DESC, id DESC);

COMMENT ON TABLE dispatch_pings IS 'One row per driver per dispatch ping; the driver portal shows the newest ping as a message.';

INSERT INTO drivers (id, display_name)
VALUES
    ('VF-1001', 'Marcus Vance'),
    ('VF-1002', 'David Sterling'),
    ('VF-1003', 'Elena Marquez'),
    ('VF-2004', 'Naomi Laurent')
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name;

-- -----------------------------------------------------------------------------
-- Client and dispatcher accounts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role           text NOT NULL,
    display_name   varchar(120) NOT NULL,
    email          varchar(254) NOT NULL,
    password_salt  varchar(128) NOT NULL,
    password_hash  varchar(256) NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT accounts_role_check CHECK (role IN ('client', 'dispatcher')),
    CONSTRAINT accounts_display_name_check CHECK (btrim(display_name) <> ''),
    CONSTRAINT accounts_email_check CHECK (btrim(email) <> ''),
    CONSTRAINT accounts_role_email_key UNIQUE (role, email)
);

CREATE INDEX IF NOT EXISTS accounts_email_idx ON accounts (email);

CREATE TABLE IF NOT EXISTS dispatchers (
    account_id           uuid PRIMARY KEY,
    reset_token          varchar(128),
    reset_token_expires  timestamptz,

    CONSTRAINT dispatchers_account_fkey
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT dispatchers_reset_pair_check
        CHECK ((reset_token IS NULL) = (reset_token_expires IS NULL))
);

-- Existing installations may already have a dispatcher profile table.
ALTER TABLE dispatchers ADD COLUMN IF NOT EXISTS reset_token varchar(128);
ALTER TABLE dispatchers ADD COLUMN IF NOT EXISTS reset_token_expires timestamptz;

COMMENT ON COLUMN dispatchers.reset_token IS 'SHA-256 hash of the one-time reset token; the raw token is never persisted.';
COMMENT ON COLUMN dispatchers.reset_token_expires IS 'Expiration time for the one-time password reset token.';
CREATE INDEX IF NOT EXISTS dispatchers_reset_token_idx ON dispatchers (reset_token);

-- -----------------------------------------------------------------------------
-- Authenticated sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  char(64) PRIMARY KEY,
    account_id  uuid NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sessions_account_fkey
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE ON UPDATE CASCADE
);

COMMENT ON TABLE sessions IS 'Server-side sessions; only the SHA-256 hash of the cookie token is stored.';
COMMENT ON COLUMN sessions.expires_at IS 'Sessions past this timestamp are rejected and deleted on access.';

CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- -----------------------------------------------------------------------------
-- Reservations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pickup_location  varchar(200) NOT NULL,
    dropoff_location varchar(200) NOT NULL,
    pickup_datetime  timestamptz NOT NULL,
    vehicle_type     text NOT NULL,
    passenger_count  smallint NOT NULL,
    status           text NOT NULL DEFAULT 'pending',
    vehicle_id       uuid,
    driver_id        varchar(50),
    assigned_vehicle varchar(100),
    luggage_notes    varchar(500),
    beverage_request varchar(200),
    special_requests varchar(1000),
    preferred_driver_id varchar(50),
    client_email     varchar(254),
    client_name      varchar(120),
    client_phone     varchar(30),
    billing_mode     text NOT NULL DEFAULT 'point_to_point',
    base_rate_cents  integer NOT NULL DEFAULT 0,
    charter_hours    numeric(4, 2),
    gratuity_cents   integer NOT NULL DEFAULT 0,
    deposit_cents    integer NOT NULL DEFAULT 0,
    fare_cents       integer NOT NULL DEFAULT 0,
    total_cents      integer NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT bookings_pickup_location_check
        CHECK (btrim(pickup_location) <> ''),
    CONSTRAINT bookings_dropoff_location_check
        CHECK (btrim(dropoff_location) <> ''),
    CONSTRAINT bookings_vehicle_type_check
        CHECK (vehicle_type IN ('sedan', 'suv', 'sprinter', 'limousine')),
    CONSTRAINT bookings_passenger_count_check
        CHECK (passenger_count BETWEEN 1 AND 16),
    CONSTRAINT bookings_status_check
        CHECK (status IN (
            'pending', 'confirmed', 'assigned', 'en_route', 'arrived',
            'passenger_aboard', 'dropped_off', 'completed', 'cancelled'
        )),
    CONSTRAINT bookings_billing_mode_check
        CHECK (billing_mode IN ('point_to_point', 'hourly')),
    CONSTRAINT bookings_charter_hours_check
        CHECK (charter_hours IS NULL OR charter_hours BETWEEN 0.5 AND 24),
    CONSTRAINT bookings_billing_nonnegative_check
        CHECK (
            base_rate_cents >= 0 AND gratuity_cents >= 0
            AND deposit_cents >= 0 AND fare_cents >= 0 AND total_cents >= 0
        ),
    CONSTRAINT bookings_vehicle_id_fkey
        FOREIGN KEY (vehicle_id) REFERENCES vehicles (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,
    CONSTRAINT bookings_driver_id_fkey
        FOREIGN KEY (driver_id) REFERENCES drivers (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,
    CONSTRAINT bookings_preferred_driver_id_fkey
        FOREIGN KEY (preferred_driver_id) REFERENCES drivers (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

-- Bring installations created from an earlier schema revision forward safely.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS driver_id varchar(50);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assigned_vehicle varchar(100);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS luggage_notes varchar(500);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS beverage_request varchar(200);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS special_requests varchar(1000);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS preferred_driver_id varchar(50);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_email varchar(254);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_name varchar(120);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_phone varchar(30);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'point_to_point';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS base_rate_cents integer NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS charter_hours numeric(4, 2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gratuity_cents integer NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_cents integer NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fare_cents integer NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_cents integer NOT NULL DEFAULT 0;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_passenger_count_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_passenger_count_check
    CHECK (passenger_count BETWEEN 1 AND 16);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_billing_mode_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_billing_mode_check
    CHECK (billing_mode IN ('point_to_point', 'hourly'));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_charter_hours_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_charter_hours_check
    CHECK (charter_hours IS NULL OR charter_hours BETWEEN 0.5 AND 24);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_billing_nonnegative_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_billing_nonnegative_check
    CHECK (
        base_rate_cents >= 0 AND gratuity_cents >= 0
        AND deposit_cents >= 0 AND fare_cents >= 0 AND total_cents >= 0
    );

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
        'pending', 'confirmed', 'assigned', 'en_route', 'arrived',
        'passenger_aboard', 'dropped_off', 'completed', 'cancelled'
    ));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_driver_id_fkey;
ALTER TABLE bookings ADD CONSTRAINT bookings_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES drivers (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_preferred_driver_id_fkey;
ALTER TABLE bookings ADD CONSTRAINT bookings_preferred_driver_id_fkey
    FOREIGN KEY (preferred_driver_id) REFERENCES drivers (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

COMMENT ON TABLE bookings IS 'Client ride reservations managed from the dispatcher dashboard.';
COMMENT ON COLUMN bookings.pickup_datetime IS 'Scheduled pickup time; stored with time zone.';
COMMENT ON COLUMN bookings.vehicle_type IS 'Requested class; vehicles.category must match once assigned.';
COMMENT ON COLUMN bookings.status IS 'pending | confirmed | assigned | en_route | arrived | passenger_aboard | dropped_off | completed | cancelled.';
COMMENT ON COLUMN bookings.vehicle_id IS 'Fleet vehicle assigned to the ride, or NULL while unassigned.';
COMMENT ON COLUMN bookings.driver_id IS 'Driver ID assigned to the ride and used by the mobile manifest.';
COMMENT ON COLUMN bookings.assigned_vehicle IS 'Human-readable fleet label displayed to the driver.';
COMMENT ON COLUMN bookings.preferred_driver_id IS 'Optional chauffeur requested by the client; dispatch makes the final assignment.';
COMMENT ON COLUMN bookings.beverage_request IS 'Optional beverage amenity requested by the client.';
COMMENT ON COLUMN bookings.special_requests IS 'Accessibility, assistance, or other trip-specific requests.';
COMMENT ON COLUMN bookings.billing_mode IS 'point_to_point flat fare, or hourly charter billed against charter_hours.';
COMMENT ON COLUMN bookings.base_rate_cents IS 'Flat fare in cents (point_to_point) or hourly rate in cents (hourly).';
COMMENT ON COLUMN bookings.charter_hours IS 'Billable hours for hourly charters; NULL for point-to-point rides.';
COMMENT ON COLUMN bookings.gratuity_cents IS 'Gratuity in cents, included in total_cents.';
COMMENT ON COLUMN bookings.deposit_cents IS 'Prepaid deposit in cents; reported separately from recognized revenue.';
COMMENT ON COLUMN bookings.fare_cents IS 'Derived fare: base_rate_cents, or base_rate_cents * charter_hours.';
COMMENT ON COLUMN bookings.total_cents IS 'Derived trip total: fare_cents + gratuity_cents.';

CREATE INDEX IF NOT EXISTS bookings_billing_mode_idx ON bookings (billing_mode);
CREATE INDEX IF NOT EXISTS bookings_completed_pickup_idx
    ON bookings (pickup_datetime) WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_pickup_datetime_idx ON bookings (pickup_datetime);
CREATE INDEX IF NOT EXISTS bookings_vehicle_id_idx ON bookings (vehicle_id);
CREATE INDEX IF NOT EXISTS bookings_driver_id_idx ON bookings (driver_id);
CREATE INDEX IF NOT EXISTS bookings_preferred_driver_id_idx ON bookings (preferred_driver_id);
CREATE INDEX IF NOT EXISTS bookings_client_email_idx ON bookings (client_email);
CREATE INDEX IF NOT EXISTS bookings_created_at_idx ON bookings (created_at DESC);

-- -----------------------------------------------------------------------------
-- Client ratings and product feedback
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_reviews (
    booking_id    uuid PRIMARY KEY,
    client_email  varchar(254) NOT NULL,
    driver_id     varchar(50),
    rating        smallint NOT NULL,
    feedback      varchar(1000),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT trip_reviews_booking_fkey
        FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT trip_reviews_driver_fkey
        FOREIGN KEY (driver_id) REFERENCES drivers (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT trip_reviews_rating_check CHECK (rating BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS trip_reviews_driver_idx ON trip_reviews (driver_id);
CREATE INDEX IF NOT EXISTS trip_reviews_client_email_idx ON trip_reviews (client_email);

CREATE TABLE IF NOT EXISTS app_feedback (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_email  varchar(254) NOT NULL,
    category      text NOT NULL,
    message       varchar(2000) NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT app_feedback_category_check
        CHECK (category IN ('experience', 'booking', 'portal', 'other')),
    CONSTRAINT app_feedback_message_check CHECK (btrim(message) <> '')
);

CREATE INDEX IF NOT EXISTS app_feedback_created_at_idx ON app_feedback (created_at DESC);

-- -----------------------------------------------------------------------------
-- Driver telemetry history
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_telemetry (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    driver_id    varchar(50) NOT NULL,
    booking_id   uuid NOT NULL,
    latitude     double precision NOT NULL,
    longitude    double precision NOT NULL,
    accuracy     double precision,
    heading      double precision,
    speed        double precision,
    recorded_at  timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT driver_telemetry_driver_fkey
        FOREIGN KEY (driver_id) REFERENCES drivers (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT driver_telemetry_booking_fkey
        FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT driver_telemetry_latitude_check CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT driver_telemetry_longitude_check CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT driver_telemetry_accuracy_check CHECK (accuracy IS NULL OR accuracy >= 0),
    CONSTRAINT driver_telemetry_heading_check CHECK (heading IS NULL OR heading BETWEEN 0 AND 360),
    CONSTRAINT driver_telemetry_speed_check CHECK (speed IS NULL OR speed >= 0)
);

CREATE INDEX IF NOT EXISTS driver_telemetry_driver_recorded_idx
    ON driver_telemetry (driver_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS driver_telemetry_booking_recorded_idx
    ON driver_telemetry (booking_id, recorded_at DESC);

-- -----------------------------------------------------------------------------
-- Keep updated_at current on every row change
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicles_set_updated_at ON vehicles;
CREATE TRIGGER vehicles_set_updated_at
    BEFORE UPDATE ON vehicles
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS drivers_set_updated_at ON drivers;
CREATE TRIGGER drivers_set_updated_at
    BEFORE UPDATE ON drivers
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS accounts_set_updated_at ON accounts;
CREATE TRIGGER accounts_set_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trip_reviews_set_updated_at ON trip_reviews;
CREATE TRIGGER trip_reviews_set_updated_at
    BEFORE UPDATE ON trip_reviews
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS bookings_set_updated_at ON bookings;
CREATE TRIGGER bookings_set_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;
