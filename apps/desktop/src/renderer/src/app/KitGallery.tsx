/**
 * Dev-only gallery of the UI kit (browser harness: `?kit` next to `?window=main&state=<id>`),
 * with every tile state, the confirm button, pills, chips, bars, the countdown, fields and the
 * settings controls, in the window's real width. A reference for section and window owners and
 * for visual review; production bundles never include it (`import.meta.env.DEV`).
 */
import {
  BookOpen,
  Clock,
  Gamepad2,
  Lock,
  MoreHorizontal,
  Palette,
  ShieldAlert,
  Timer,
  Tv,
} from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import {
  Bar,
  Checkbox,
  Chip,
  ConfirmButton,
  Countdown,
  EmptyState,
  Field,
  HelpLine,
  InPlaceConfirm,
  Pill,
  Section,
  Segmented,
  SettingsRow,
  StatusDot,
  TextButton,
  Tile,
  TileRow,
  Toggle,
  settingsRowIds,
} from '../components';
import { useClockNow } from '../hooks/useNow';

export function KitGallery(): React.JSX.Element {
  const now = useClockNow();
  const [mode, setMode] = useState<'normal' | 'strict' | 'hardcore' | 'exam'>('strict');
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const [text, setText] = useState('no veo YouTube en una hora');
  const [on, setOn] = useState(true);
  const [check, setCheck] = useState(true);
  const [compact, setCompact] = useState(false);

  // The gallery is taller than a window: let the harness frame grow with it.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--harness-window-height', 'auto');
  }, []);

  const toggleDensity = (): void => {
    const next = !compact;
    setCompact(next);
    document.documentElement.dataset['density'] = next ? 'compact' : 'regular';
  };

  return (
    <div className="main-shell" style={{ height: 'auto' }}>
      <main className="main-sections" aria-label="Kit">
        <Section
          id="kit-bloqueo"
          icon={Lock}
          title="Bloqueo: YouTube, Instagram · Estricto"
          datum="hasta 17:42"
          pill={
            <Pill tone="blue" onPress={() => undefined}>
              Nuevo
            </Pill>
          }
        >
          <Countdown endsAt={now + (42 * 60 + 10) * 1000} />
          <Bar value={0.3} height={3} tone="orange" />
          <HelpLine>
            <em>Quiero aprobar mates</em>
          </HelpLine>
          <TileRow
            id="kit-extend"
            label="Ampliar"
            help="+30 min · termina a las 18:12 · Deshacer (4 s)"
          >
            <Tile id="15" label="+15 min" icon={Clock} help="Ampliar 15 minutos" mnemonic="1" />
            <Tile id="30" label="+30 min" icon={Clock} help="Ampliar 30 minutos" mnemonic="3" />
            <Tile
              id="60"
              label="+1 h"
              icon={Clock}
              disabled
              disabledReason="Como mucho 24 h en total"
            />
            <Tile id="otro" label="Otro" icon={MoreHorizontal} door help="Elige cuántos minutos" />
          </TileRow>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Countdown endsAt={now + 25 * 60_000} size="row" />
            <TextButton onPress={() => undefined}>Desbloqueo de emergencia…</TextButton>
          </div>
        </Section>

        <Section id="kit-modos" icon={ShieldAlert} title="Modo: selección" datum={mode}>
          <Segmented
            id="kit-modes"
            label="Modo"
            size="regular"
            value={mode}
            onChange={setMode}
            help="Elige cómo de difícil es cancelarlo"
            options={[
              {
                value: 'normal',
                label: 'Normal',
                tone: 'blue',
                icon: BookOpen,
                help: 'Normal: emergencia de 10 min',
              },
              {
                value: 'strict',
                label: 'Estricto',
                tone: 'orange',
                icon: Timer,
                help: 'Estricto: la emergencia tarda 30 min y cuesta al menos 200 puntos',
              },
              {
                value: 'hardcore',
                label: 'Hardcore',
                tone: 'red',
                icon: Gamepad2,
                help: 'Hardcore: no se puede cancelar',
              },
              {
                value: 'exam',
                label: 'Examen',
                tone: 'red',
                icon: Tv,
                help: 'Examen: lista blanca + Hardcore',
              },
            ]}
          />
          <TileRow
            id="kit-confirm"
            label="Confirmar"
            columns={4}
            help="Solo se puede ampliar, nunca acortar"
          >
            <Tile
              id="editar"
              label="Editar"
              door
              size="door"
              help="Abre Bloqueos con este borrador"
            />
            <InPlaceConfirm
              id="seguro"
              armId="kit-armed"
              label="Desbloquear"
              size="door"
              help="Primer clic: ¿Seguro?"
              consequence="Perderás 620 puntos y tu racha de 5 días"
              onConfirm={() => undefined}
            />
            <ConfirmButton
              label="Bloquear hasta 17:42"
              onPress={() => undefined}
              className="col-span-2"
            />
          </TileRow>
          <ConfirmButton label="Sí, bloquear 6 h" disabled onPress={() => undefined} />
        </Section>

        <Section id="kit-bits" icon={Palette} title="Piezas" datum={<StatusDot tone="green" />}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill tone="red">Números rojos</Pill>
            <Pill tone="red">● Cámara activa</Pill>
            <Pill tone="green">Hecho</Pill>
            <Pill tone="neutral">Neutro</Pill>
            <Chip label="YouTube" leading={<b>YT</b>} onPress={() => undefined} />
            <Chip label="1 h" onPress={() => undefined} selected />
            <Chip label="hasta 17:42" />
          </div>
          <HelpLine tone="red">El guardián no responde · Reintentar · Reparar</HelpLine>
          <HelpLine tone="orange">Chrome no tiene la extensión</HelpLine>
          <HelpLine tone="green">Hecho. +80 puntos</HelpLine>
          <Bar value={0.7} height={4} tone="green" />
          <Bar value={0.5} height={6} tone="blue" label="Concentración" valueText="50 %" />
          <Field
            value={text}
            onChange={setText}
            label="¿Qué quieres hacer?"
            size="main"
            placeholder="¿Qué quieres hacer?"
          />
          <Field
            value=""
            onChange={() => undefined}
            label="Tu motivo"
            placeholder="Tu motivo (opcional)"
          />
          <TileRow id="kit-density" label="Densidad" columns={3}>
            <Tile
              id="density"
              label={compact ? 'Densidad normal' : 'Densidad compacta'}
              size="text"
              onPress={toggleDensity}
            />
          </TileRow>
        </Section>

        <Section id="kit-ajustes" icon={Palette} title="Ajustes">
          <SettingsRow id="kit-theme" title="Tema" description="Sigue al sistema o elige uno">
            <span />
          </SettingsRow>
          <Segmented
            id="kit-theme-row"
            label="Tema"
            columns={3}
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: 'Sistema', mnemonic: 'y' },
              { value: 'light', label: 'Claro', mnemonic: 'c' },
              { value: 'dark', label: 'Oscuro', mnemonic: 'o' },
            ]}
          />
          <SettingsRow
            id="kit-auto"
            title="Arranque automático"
            description="Al iniciar sesión, en la bandeja"
          >
            <Toggle checked={on} onChange={setOn} labelledBy={settingsRowIds('kit-auto').title} />
          </SettingsRow>
          <Checkbox checked={check} onChange={setCheck} label="Cerrar navegadores sin extensión" />
          <EmptyState
            icon={Clock}
            text="Tus estadísticas aparecerán después de tu primera sesión"
            action={{ label: 'Empezar 25 min', onPress: () => undefined, icon: Timer }}
          />
        </Section>
      </main>
    </div>
  );
}
