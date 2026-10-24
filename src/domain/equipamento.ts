import {
  EstadoFisico,
  StatusLote,
  StatusRastreamento,
  TipoEquipamento,
} from '../generated/prisma/enums.js';
import { ErroRegraNegocio, ErroValidacao } from './erros.js';

// -----------------------------------------------------------------------------
// Estado físico
// -----------------------------------------------------------------------------

/** Do melhor para o pior. A posição no array é a "categoria". */
export const ORDEM_ESTADO_FISICO: readonly EstadoFisico[] = [
  EstadoFisico.NOVO,
  EstadoFisico.BOM_ESTADO,
  EstadoFisico.USADO_LEVE,
  EstadoFisico.USADO_MODERADO,
  EstadoFisico.DANIFICADO_LEVE,
  EstadoFisico.DANIFICADO_GRAVE,
  EstadoFisico.INSERVIVEL,
];

/** Quantas categorias o estado piorou (negativo = melhorou). */
export function quedaDeCategorias(anterior: EstadoFisico, novo: EstadoFisico): number {
  return ORDEM_ESTADO_FISICO.indexOf(novo) - ORDEM_ESTADO_FISICO.indexOf(anterior);
}

/**
 * Regra herdada do CLI: justificativa textual obrigatória quando o estado cai
 * "duas categorias abaixo do estado anterior". Interpretamos como queda de
 * DUAS OU MAIS categorias - exigir apenas para exatamente duas deixaria uma
 * queda de três (ex.: NOVO -> USADO_MODERADO) sem justificativa.
 */
export function exigeJustificativaEstado(anterior: EstadoFisico, novo: EstadoFisico): boolean {
  return quedaDeCategorias(anterior, novo) >= 2;
}

// -----------------------------------------------------------------------------
// Máquina de estados do rastreamento
// -----------------------------------------------------------------------------

export const TRANSICOES_STATUS: Readonly<Record<StatusRastreamento, readonly StatusRastreamento[]>> = {
  AGUARDANDO_TRIAGEM: [StatusRastreamento.EM_TRIAGEM],
  // Saídas da triagem: segue para desmonte ou vai direto para descarte seguro
  EM_TRIAGEM: [StatusRastreamento.AGUARDANDO_DESMONTE, StatusRastreamento.DESCARTE_SEGURO],
  AGUARDANDO_DESMONTE: [StatusRastreamento.EM_DESMONTE],
  EM_DESMONTE: [
    StatusRastreamento.PECAS_REAPROVEITADAS,
    StatusRastreamento.MATERIAL_RECICLAVEL,
    StatusRastreamento.DESCARTE_SEGURO,
  ],
  PECAS_REAPROVEITADAS: [StatusRastreamento.BAIXA_DEFINITIVA],
  MATERIAL_RECICLAVEL: [StatusRastreamento.BAIXA_DEFINITIVA],
  DESCARTE_SEGURO: [StatusRastreamento.BAIXA_DEFINITIVA],
  BAIXA_DEFINITIVA: [],
};

/** Status que indicam que o equipamento ainda não terminou a triagem. */
export const STATUS_PRE_TRIAGEM: readonly StatusRastreamento[] = [
  StatusRastreamento.AGUARDANDO_TRIAGEM,
  StatusRastreamento.EM_TRIAGEM,
];

/** Situações do lote em que a triagem já está completa. */
const LOTE_COM_TRIAGEM_COMPLETA: readonly StatusLote[] = [
  StatusLote.TRIAGEM_CONCLUIDA,
  StatusLote.ENCAMINHADO,
];

const ESTADOS_QUE_PERMITEM_DESCARTE_DIRETO: readonly EstadoFisico[] = [
  EstadoFisico.DANIFICADO_GRAVE,
  EstadoFisico.INSERVIVEL,
];

// -----------------------------------------------------------------------------
// Depreciação
// -----------------------------------------------------------------------------

/** Vida útil contábil de referência, em anos (parâmetro de negócio). */
export const VIDA_UTIL_ANOS: Readonly<Record<TipoEquipamento, number>> = {
  COMPUTADOR_MESA: 5,
  NOTEBOOK: 5,
  MONITOR: 5,
  IMPRESSORA: 5,
  SERVIDOR: 5,
  ROTEADOR: 5,
  CABO_ESTRUTURADO: 10,
  FONTE_ALIMENTACAO: 5,
};

/** Fração do valor residual que o estado físico preserva. */
export const FATOR_ESTADO_FISICO: Readonly<Record<EstadoFisico, number>> = {
  NOVO: 1,
  BOM_ESTADO: 0.9,
  USADO_LEVE: 0.8,
  USADO_MODERADO: 0.65,
  DANIFICADO_LEVE: 0.45,
  DANIFICADO_GRAVE: 0.2,
  INSERVIVEL: 0,
};

// -----------------------------------------------------------------------------
// Código de barras interno
// -----------------------------------------------------------------------------

export const PREFIXO_TIPO: Readonly<Record<TipoEquipamento, string>> = {
  COMPUTADOR_MESA: 'CM',
  NOTEBOOK: 'NB',
  MONITOR: 'MN',
  IMPRESSORA: 'IP',
  SERVIDOR: 'SV',
  ROTEADOR: 'RT',
  CABO_ESTRUTURADO: 'CE',
  FONTE_ALIMENTACAO: 'FA',
};

/** Dígito verificador no padrão EAN (pesos 3 e 1 da direita para a esquerda). */
export function digitoVerificadorEan(digitos: string): number {
  let soma = 0;
  for (let i = 0; i < digitos.length; i++) {
    const d = Number(digitos[digitos.length - 1 - i]);
    soma += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (soma % 10)) % 10;
}

/** Formato: GC + prefixo do tipo + sequência de 9 dígitos + DV. Ex.: GCNB0000000127 */
export function gerarCodigoBarras(tipo: TipoEquipamento, sequencia: number): string {
  if (!Number.isInteger(sequencia) || sequencia < 1 || sequencia > 999_999_999) {
    throw new ErroValidacao('Sequência do código de barras fora da faixa permitida');
  }
  const seq = String(sequencia).padStart(9, '0');
  return `GC${PREFIXO_TIPO[tipo]}${seq}${digitoVerificadorEan(seq)}`;
}

export function codigoBarrasValido(codigo: string): boolean {
  const m = /^GC([A-Z]{2})(\d{9})(\d)$/.exec(codigo);
  if (!m) return false;
  return Object.values(PREFIXO_TIPO).includes(m[1]!) && digitoVerificadorEan(m[2]!) === Number(m[3]);
}

// -----------------------------------------------------------------------------
// Entidade
// -----------------------------------------------------------------------------

export interface DadosEquipamento {
  id: string;
  codigoBarrasInterno: string;
  tipo: TipoEquipamento;
  marca: string;
  modelo: string;
  anoFabricacao: number;
  estadoFisico: EstadoFisico;
  pesoQuilogramas: number;
  loteId: string;
  posicaoNoLote: number;
  statusRastreamento: StatusRastreamento;
  versao: number;
}

export interface TransicaoStatus {
  origem: StatusRastreamento;
  destino: StatusRastreamento;
}

export class Equipamento {
  private constructor(private readonly dados: DadosEquipamento) {}

  static restaurar(dados: DadosEquipamento): Equipamento {
    return new Equipamento({ ...dados });
  }

  /** Validações de cadastro (antes de existir id/código). */
  static validarNovo(dados: {
    anoFabricacao: number;
    pesoQuilogramas: number;
    marca: string;
    modelo: string;
  }, agora = new Date()): void {
    const anoAtual = agora.getFullYear();
    if (dados.anoFabricacao < 1970 || dados.anoFabricacao > anoAtual) {
      throw new ErroValidacao(`anoFabricacao deve estar entre 1970 e ${anoAtual}`);
    }
    if (!(dados.pesoQuilogramas > 0) || dados.pesoQuilogramas > 5000) {
      throw new ErroValidacao('pesoQuilogramas deve ser maior que 0 e no máximo 5000');
    }
    if (!dados.marca.trim() || !dados.modelo.trim()) {
      throw new ErroValidacao('marca e modelo são obrigatórios');
    }
  }

  get id() { return this.dados.id; }
  get versao() { return this.dados.versao; }
  get statusRastreamento() { return this.dados.statusRastreamento; }
  get estadoFisico() { return this.dados.estadoFisico; }
  get pesoQuilogramas() { return this.dados.pesoQuilogramas; }

  /**
   * Aplica a máquina de estados. `statusLote` é necessário porque a entrada em
   * desmonte só é permitida depois que a triagem do LOTE estiver completa.
   */
  atualizarStatus(
    novoStatus: StatusRastreamento,
    justificativa: string | undefined,
    statusLote: StatusLote,
  ): TransicaoStatus {
    const atual = this.dados.statusRastreamento;
    if (!TRANSICOES_STATUS[atual].includes(novoStatus)) {
      throw new ErroRegraNegocio(`Transição de status inválida: ${atual} -> ${novoStatus}`, {
        permitidas: TRANSICOES_STATUS[atual],
      });
    }

    if (atual === StatusRastreamento.EM_TRIAGEM && statusLote !== StatusLote.EM_TRIAGEM) {
      throw new ErroRegraNegocio('A classificação da triagem só pode ocorrer com o lote EM_TRIAGEM');
    }

    if (novoStatus === StatusRastreamento.EM_DESMONTE && !LOTE_COM_TRIAGEM_COMPLETA.includes(statusLote)) {
      throw new ErroRegraNegocio(
        'O equipamento só pode ir para desmonte após a triagem completa do lote (TRIAGEM_CONCLUIDA)',
      );
    }

    if (
      atual === StatusRastreamento.EM_TRIAGEM &&
      novoStatus === StatusRastreamento.DESCARTE_SEGURO &&
      !ESTADOS_QUE_PERMITEM_DESCARTE_DIRETO.includes(this.dados.estadoFisico)
    ) {
      throw new ErroRegraNegocio(
        'Descarte direto na triagem só é permitido para equipamentos DANIFICADO_GRAVE ou INSERVIVEL',
      );
    }

    if (novoStatus === StatusRastreamento.DESCARTE_SEGURO && !justificativa?.trim()) {
      throw new ErroValidacao('Justificativa é obrigatória para encaminhar ao descarte seguro');
    }

    this.dados.statusRastreamento = novoStatus;
    return { origem: atual, destino: novoStatus };
  }

  alterarEstadoFisico(novoEstado: EstadoFisico, justificativa?: string): void {
    const anterior = this.dados.estadoFisico;
    if (anterior === novoEstado) {
      throw new ErroRegraNegocio(`O equipamento já está no estado ${novoEstado}`);
    }
    if (this.dados.statusRastreamento === StatusRastreamento.BAIXA_DEFINITIVA) {
      throw new ErroRegraNegocio('Equipamento com baixa definitiva não pode ser alterado');
    }
    if (exigeJustificativaEstado(anterior, novoEstado) && !justificativa?.trim()) {
      throw new ErroValidacao(
        `Justificativa obrigatória: o estado caiu ${quedaDeCategorias(anterior, novoEstado)} categorias (${anterior} -> ${novoEstado})`,
      );
    }
    this.dados.estadoFisico = novoEstado;
  }

  /** Percentual já depreciado (0 a 1), combinando idade e estado físico. */
  calcularDepreciacao(referencia = new Date()): number {
    const idade = Math.max(0, referencia.getFullYear() - this.dados.anoFabricacao);
    const vidaUtil = VIDA_UTIL_ANOS[this.dados.tipo];
    const residualPorIdade = 1 - Math.min(1, idade / vidaUtil);
    const residual = residualPorIdade * FATOR_ESTADO_FISICO[this.dados.estadoFisico];
    return Math.round((1 - residual) * 10_000) / 10_000;
  }
}
